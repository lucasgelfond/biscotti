<script>
  import architecture from "../../../docs/architecture.txt?raw";
  const version = __VERSION__;
  const biscotti = String.raw`
        _.-~~~~~~~~~~~~~~~~~~~~-._
     .-'  o    .   (_)    .   o   '-.
    /  .   (_)   .    o   (_)   .    \
   /  o   .    o   (_)   .    o   .   \
  /__(_)____.____o____.____(_)____o____\
`.trimEnd();
</script>

<main>
  <pre class="art" aria-label="biscotti">{biscotti}</pre>
  <h1>A lightweight iMessage agent that runs on hardware you own</h1>

  <p class="links">
    <a href="/biscotti-installer.zip">[ Download the installer (macOS) ]</a>
    <a href="https://github.com/lucasgelfond/biscotti">[ View the source ]</a>
    <span class="version">v{version}</span>
  </p>

  <details open>
    <summary>Examples</summary>
    <!-- Demo GIFs go here, e.g. <img class="demo" src="img/example-booking.gif" alt="…" /> -->
  </details>

  <details open>
    <summary>Design</summary>
    <pre class="diagram" aria-label="biscotti's architecture">{architecture}</pre>
  </details>

  <details open>
    <summary>Setup</summary>
    <p>
      You can install biscotti on all targets (M3+ Macs, Raspberry Pis, or on dedicated cloud machines, i.e. those with
      KVM access) using the install wizard.
    </p>
    <img class="demo" src="img/installer-pi.gif" width="1000" height="1019" alt="The install wizard, setting up a Raspberry Pi" />
  </details>

</main>
