# syntax=docker/dockerfile:1
# Minimal multi-arch Cua desktop (XFCE + TigerVNC + noVNC + Chromium + cua-spacesd) plus the task agent (pi).
# Startup scripts and configs come straight from Cua at a pinned commit; nothing is vendored.
FROM debian:trixie-slim

ARG CUA_COMMIT=075add55cf938f4e351b74539efa18d4976696ae
ARG CUA_SPACESD_VERSION=0.1.0
ARG NODE_VERSION=22.23.3
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/cua DISPLAY=:1 \
    VNC_PORT=5901 NOVNC_PORT=6901 CUA_ENV_PORT=3211 \
    VNC_RESOLUTION=1280x800 VNC_COL_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal dbus-x11 x11-utils x11-xserver-utils \
      tigervnc-standalone-server tigervnc-tools \
      chromium chromium-sandbox fonts-dejavu \
      supervisor sudo isc-dhcp-client python3 git ca-certificates curl \
      xdotool xclip wmctrl chrony socat xz-utils scrot \
    && rm -rf /var/lib/apt/lists/*

ARG NOVNC_COMMIT=ad7012fc021ee785a2877067f5b69ee94c3948c6
ARG WEBSOCKIFY_COMMIT=3dd228b81ade1ff76a27ad12eed6e78df8c6f8a6
RUN for r in "trycua/noVNC $NOVNC_COMMIT /opt/noVNC" "novnc/websockify $WEBSOCKIFY_COMMIT /opt/noVNC/utils/websockify"; do \
      set -- $r && git init -q "$3" && git -C "$3" fetch -q --depth 1 "https://github.com/$1" "$2" && git -C "$3" checkout -q FETCH_HEAD; done

RUN case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; esac && \
    mkdir -p /tmp/cua-spacesd && \
    curl -fsSL "https://github.com/trycua/cua/releases/download/cua-spacesd-v${CUA_SPACESD_VERSION}/cua-spacesd-${a}-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /tmp/cua-spacesd cua-spacesd LICENSE THIRD_PARTY_NOTICES.md && \
    install -m 0755 /tmp/cua-spacesd/cua-spacesd /usr/local/bin/cua-spacesd && \
    install -d /usr/share/licenses/cua-spacesd && \
    install -m 0644 /tmp/cua-spacesd/LICENSE /tmp/cua-spacesd/THIRD_PARTY_NOTICES.md /usr/share/licenses/cua-spacesd/ && \
    rm -rf /tmp/cua-spacesd

RUN case "$TARGETARCH" in \
      amd64) a=x64 sum=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de ;; \
      arm64) a=arm64 sum=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;; esac && \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${a}.tar.xz" && \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c - && \
    tar -xJ -C /usr/local --strip-components=1 -f /tmp/node.tar.xz && rm /tmp/node.tar.xz

# pnpm for coding tasks, through corepack, fetched now so a task needn't.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack install -g pnpm@10.29.1 && chmod -R a+rX /opt/corepack

# Ad and tracker blocklist (StevenBlack/hosts at a pinned commit), appended to /etc/hosts at boot.
RUN curl -fsSL -o /etc/hosts.block \
      https://raw.githubusercontent.com/StevenBlack/hosts/2025dea10a1d17c41acf1035056e5c4a2913ebfc/hosts && \
    echo "b83fc7acc934248ea4995dac213aa0ebb92d6824fd8469c1c20327b445db9051  /etc/hosts.block" | sha256sum -c -

# The task agent: pi and Playwright's MCP server from a lockfile, reaching the model through the host's gate (which
# adds the key).
COPY task/package.json task/package-lock.json /opt/pi/
RUN cd /opt/pi && npm ci --omit=dev --ignore-scripts && ln -s /opt/pi/node_modules/.bin/pi /opt/pi/node_modules/.bin/playwright-mcp /usr/local/bin/
COPY task/biscotti-task task/biscotti-start /usr/local/bin/
COPY task/models.json task/mcp.json /home/cua/.pi/agent/
COPY task/reload.ts task/lean.ts /home/cua/.pi/agent/extensions/
COPY biscotti.html /opt/noVNC/

# Wallpaper: "biscotti" by Geertje Caliguire on Unsplash (Unsplash License), fetched at a pinned size and checksum.
RUN mkdir -p /usr/share/backgrounds && \
    curl -fsSL -o /usr/share/backgrounds/biscotti.jpg \
      "https://images.unsplash.com/photo-1685397166172-0308e96ee012?fm=jpg&q=85&w=1280&h=800&fit=crop" && \
    echo "aa403dc64a9378a59a8fc137e27d8246d55b5f7c363fbd93080e52e8daa9942e  /usr/share/backgrounds/biscotti.jpg" | sha256sum -c -
COPY xfce4-desktop.xml /home/cua/.config/xfce4/xfconf/xfce-perchannel-xml/

ADD --chmod=0644 https://raw.githubusercontent.com/trycua/cua/${CUA_COMMIT}/LICENSE.md /usr/share/licenses/cua-xfce/LICENSE.md

ARG CUA_SRC=https://raw.githubusercontent.com/trycua/cua/${CUA_COMMIT}/libs/xfce/src
ADD ${CUA_SRC}/scripts/start-vnc.sh ${CUA_SRC}/scripts/start-novnc.sh ${CUA_SRC}/scripts/start-spacesd.sh \
    ${CUA_SRC}/scripts/xstartup.sh ${CUA_SRC}/scripts/resize-display.sh /tmp/cua/scripts/
ADD ${CUA_SRC}/supervisor/supervisord.conf /tmp/cua/supervisor/
ADD ${CUA_SRC}/xfce-config/helpers.rc ${CUA_SRC}/xfce-config/xfce4-session.xml \
    ${CUA_SRC}/xfce-config/xfce4-power-manager.xml /tmp/cua/xfce-config/

RUN useradd -m -s /bin/bash -G sudo cua && echo "cua ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    cp /tmp/cua/supervisor/* /etc/supervisor/conf.d/ && \
    install -m 0755 /tmp/cua/scripts/* /usr/local/bin/ && \
    install -d -o cua -g cua -m 0700 /run/cua && \
    install -d -o cua -g cua $HOME/.config/tigervnc $HOME/.config/xfce4/xfconf/xfce-perchannel-xml $HOME/.config/autostart && \
    install -o cua -g cua /tmp/cua/xfce-config/helpers.rc $HOME/.config/xfce4/ && \
    install -o cua -g cua /tmp/cua/xfce-config/xfce4-*.xml $HOME/.config/xfce4/xfconf/xfce-perchannel-xml/ && \
    for a in xfce4-tips-autostart xfce4-screensaver light-locker xfce4-power-manager; do \
      printf '[Desktop Entry]\nHidden=true\n' > $HOME/.config/autostart/$a.desktop; done && \
    # TigerVNC 1.15 moved ~/.vnc here; the link keeps it from moving the folder (which fails on overlay filesystems).
    ln -s .config/tigervnc $HOME/.vnc && \
    chown -R cua:cua $HOME && rm -rf /tmp/cua && \
    # Replace Cua's fixed startup waits with readiness polls.
    sed -i 's|^sleep 5$|until (exec 3<>/dev/tcp/127.0.0.1/5901) 2>/dev/null; do sleep 0.1; done|' /usr/local/bin/start-novnc.sh && \
    sed -i 's|^    sleep 1$|    sleep 0.1|' /usr/local/bin/start-spacesd.sh

EXPOSE 5901 6901 3211 4000
CMD ["/usr/local/bin/biscotti-start"]
