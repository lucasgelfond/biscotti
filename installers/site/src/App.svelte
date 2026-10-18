<script>
  const repo = "https://github.com/lucasgelfond/biscotti";

  const version = __VERSION__;
  const images = [
    ["Raspberry Pi 5", "biscotti-pi5.img.zst"],
    ["Mac (Lima)", "biscotti-mac.qcow2.zst"],
    ["AWS", "biscotti-aws.vhd.zst"],
  ];
</script>

<header class="wrap hero">
  <h1>biscotti</h1>
  <p class="lede">
    A lightweight iMessage agent that runs on hardware you own. It remembers things, keeps your logins in an encrypted
    vault, and does real work on a disposable computer when a website needs clicking.
  </p>
  <div class="actions">
    <a class="button big" href="/biscotti-installer.zip">Download the installer (macOS)</a>
    <span class="version">v{version}</span>
  </div>
  <p class="needs">One app for every setup: pick a Raspberry Pi, your Mac, or a cloud server, and it walks you through.</p>
  <img class="shot demo" src="img/installer-pi.gif" width="1000" height="1019" alt="The installer's Raspberry Pi steps, from choosing a target to writing the card" />
</header>

<main>
  <section class="wrap" id="targets">
    <h2>Where it runs</h2>
    <div class="paths">
      <article class="path" id="pi">
        <p class="tag">Recommended</p>
        <h3>Raspberry Pi 5</h3>
        <p>The installer writes a microSD card with biscotti and your settings. Plug in the Pi, no screen needed, and it texts you in about 20 minutes.</p>
        <p class="needs">Pi 5 (8 GB) · microSD, 32 GB+</p>
        <div class="strip two">
          <img class="shot" src="img/app-pi-8-card.png" width="1240" height="1184" alt="Choosing the card" loading="lazy" />
          <img class="shot" src="img/app-pi-10-done.png" width="1240" height="1184" alt="Done: put the card in your Pi" loading="lazy" />
        </div>
      </article>

      <article class="path" id="mac">
        <p class="tag">In testing</p>
        <h3>Your Mac</h3>
        <p>The installer runs biscotti locally in a Lima virtual machine. M3 and later can run the task VMs inside it.</p>
        <p class="needs">Apple silicon M3+ · ~30 GB free</p>
        <div class="strip two">
          <img class="shot" src="img/app-mac-6-install.png" width="1240" height="1184" alt="Installing on this Mac" loading="lazy" />
          <img class="shot" src="img/app-mac-7-done.png" width="1240" height="1184" alt="Done: biscotti is starting in Lima" loading="lazy" />
        </div>
      </article>

      <article class="path" id="aws">
        <p class="tag">No Pi needed</p>
        <h3>A cloud server (AWS)</h3>
        <p>Give the installer an AWS access key: it launches an m8i.large running NixOS with nested virtualization and sends your settings. Deactivate the key afterwards.</p>
        <p class="needs">AWS account · m8i.large, ~$0.14/hour</p>
        <div class="strip two">
          <img class="shot" src="img/app-cloud-7-launch.png" width="1240" height="1184" alt="Launching the instance" loading="lazy" />
          <img class="shot" src="img/app-cloud-8-done.png" width="1240" height="1184" alt="Done: settings are on the machine" loading="lazy" />
        </div>
      </article>
    </div>
  </section>

  <section class="wrap" id="tailscale">
    <h2>Tailscale on your phone</h2>
    <p>biscotti lives on a private Tailscale network, so its forms and live desktop open only on your devices. You need the free Tailscale app on your iPhone.</p>
    <div class="tailscale">
      <img class="qr" src="img/qr-tailscale.svg" width="160" height="160" alt="QR code for tailscale.com/download" />
      <ol class="steps">
        <li><h4>Install</h4><p>Scan the code, or search "Tailscale" in the App Store.</p></li>
        <li><h4>Sign in</h4><p>With Google, Apple, Microsoft or GitHub. Use the same account everywhere.</p></li>
        <li>
          <h4>Add biscotti</h4>
          <p>When biscotti texts you its login link, open it on your phone and tap <b>Connect</b>.</p>
          <div class="texts" aria-label="The texts biscotti sends">
            <p class="bubble">Hi, it's biscotti! To finish setting me up, open this link and add me to your Tailscale: https://login.tailscale.com/a/…</p>
            <p class="bubble">I'm all set up. Text me anything!</p>
          </div>
        </li>
      </ol>
    </div>
  </section>

  <section class="wrap" id="how">
    <h2>How it works</h2>
    <picture>
      <source srcset="img/architecture-dark.webp" media="(prefers-color-scheme: dark)" />
      <img
        class="diagram"
        src="img/architecture-light.webp"
        width="3200"
        height="1800"
        loading="lazy"
        alt="biscotti's architecture: iMessage through Photon to pi on NixOS behind Tailscale; an encrypted SQLite store for crons, memory and the vault; Firecracker VMs with Cua and noVNC for computer use; every outside call goes through the gate."
      />
    </picture>
  </section>

  <section class="wrap" id="manual">
    <h2>Advanced / manual install</h2>
    <p>The v{version} images the installer uses, for writing or importing yourself. Settings go in <code>/var/lib/biscotti/.env</code> (see <a href="{repo}/blob/main/core/host/.env.example">.env.example</a>).</p>
    <table class="keys">
      <tbody>
        {#each images as [target, file]}
          <tr>
            <td>{target}</td>
            <td><a href="/{file}"><code>{file}</code></a></td>
            <td><a href="/{file}.sha256">sha256</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</main>

<footer class="wrap">
  <p><a href={repo}>github.com/lucasgelfond/biscotti</a></p>
</footer>
