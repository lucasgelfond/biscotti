# syntax=docker/dockerfile:1
# Minimal multi-arch Cua desktop: XFCE + TigerVNC + noVNC + Firefox + cua-spacesd.
# Startup scripts and configs come straight from Cua at a pinned commit; nothing is vendored.
FROM debian:bookworm-slim

ARG CUA_COMMIT=075add55cf938f4e351b74539efa18d4976696ae
ARG CUA_SPACESD_VERSION=0.1.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/cua DISPLAY=:1 \
    VNC_PORT=5901 NOVNC_PORT=6901 CUA_ENV_PORT=3211 \
    VNC_RESOLUTION=1280x800 VNC_COL_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal dbus-x11 x11-utils x11-xserver-utils \
      tigervnc-standalone-server tigervnc-tools \
      firefox-esr fonts-dejavu \
      supervisor sudo isc-dhcp-client python3 git ca-certificates curl \
      xdotool xclip wmctrl \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/trycua/noVNC.git /opt/noVNC && \
    git clone --depth 1 https://github.com/novnc/websockify /opt/noVNC/utils/websockify

RUN case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; esac && \
    curl -fsSL "https://github.com/trycua/cua/releases/download/cua-spacesd-v${CUA_SPACESD_VERSION}/cua-spacesd-${a}-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /usr/local/bin cua-spacesd

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
    install -d -o cua -g cua $HOME/.vnc $HOME/.config/xfce4/xfconf/xfce-perchannel-xml $HOME/.config/autostart && \
    install -o cua -g cua /tmp/cua/xfce-config/helpers.rc $HOME/.config/xfce4/ && \
    install -o cua -g cua /tmp/cua/xfce-config/xfce4-*.xml $HOME/.config/xfce4/xfconf/xfce-perchannel-xml/ && \
    for a in xfce4-tips-autostart xfce4-screensaver light-locker xfce4-power-manager; do \
      printf '[Desktop Entry]\nHidden=true\n' > $HOME/.config/autostart/$a.desktop; done && \
    chown -R cua:cua $HOME && rm -rf /tmp/cua && \
    # Replace Cua's fixed startup waits with readiness polls.
    sed -i 's|^sleep 5$|until (exec 3<>/dev/tcp/127.0.0.1/5901) 2>/dev/null; do sleep 0.1; done|' /usr/local/bin/start-novnc.sh && \
    sed -i 's|^    sleep 1$|    sleep 0.1|' /usr/local/bin/start-spacesd.sh

EXPOSE 5901 6901 3211
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
