(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const themeKey = "pi-arcweld-theme";
  const themeMeta = document.getElementById("theme-color");
  const themeToggle = document.getElementById("theme-toggle");
  const menuToggle = document.getElementById("menu-toggle");
  const overlayNav = document.getElementById("overlay-nav");

  /* ---------- strike the arc: page-load sequence ---------- */

  root.classList.add("is-striking");

  if (!reducedMotion.matches) {
    const run = document.getElementById("weld-run");
    if (run) {
      // sparks scatter from the strike point when the arc lights
      const heat = ["var(--heat-1)", "var(--heat-2)", "var(--arc-core)"];
      for (let i = 0; i < 7; i++) {
        const s = document.createElement("span");
        s.className = "spark";
        const angle = (Math.random() * 0.9 + 0.05) * Math.PI;
        const dist = 26 + Math.random() * 46;
        s.style.setProperty("--spark-x", `${Math.cos(angle) * dist}px`);
        s.style.setProperty("--spark-y", `${-Math.abs(Math.sin(angle)) * dist}px`);
        s.style.setProperty("--spark-delay", `${320 + Math.random() * 160}ms`);
        s.style.background = heat[i % heat.length];
        s.style.left = "0";
        run.appendChild(s);
        setTimeout(() => s.remove(), 1600);
      }
    }
  }

  /* ---------- theme: the auto-darkening lens ---------- */

  const applyTheme = () => {
    const night = root.dataset.theme === "night";
    themeToggle?.setAttribute("aria-label", night ? "Switch to day theme" : "Switch to night theme");
    themeToggle?.setAttribute("title", night ? "Shop lights on" : "Visor down");
    themeMeta?.setAttribute("content", night ? "#0a0f17" : "#edf0f4");
    const lens = themeToggle?.querySelector(".lens-fill");
    lens?.setAttribute("opacity", night ? "1" : "0.25");
  };

  themeToggle?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "night" ? "day" : "night";
    try { localStorage.setItem(themeKey, root.dataset.theme); } catch {}
    applyTheme();
  });

  applyTheme();

  /* ---------- mobile overlay navigation ---------- */

  const setMenu = (open) => {
    overlayNav?.setAttribute("data-open", String(open));
    menuToggle?.setAttribute("aria-expanded", String(open));
    menuToggle?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    const iconMenu = menuToggle?.querySelector(".icon-menu");
    const iconClose = menuToggle?.querySelector(".icon-close");
    if (iconMenu) iconMenu.style.display = open ? "none" : "";
    if (iconClose) iconClose.style.display = open ? "" : "none";
    // lock scroll on the root: overflow on body would re-anchor the
    // sticky header to body's own scrollport and scroll it off-screen
    root.style.overflow = open ? "hidden" : "";
  };

  menuToggle?.addEventListener("click", () => setMenu(overlayNav?.dataset.open !== "true"));
  overlayNav?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
  addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  addEventListener("resize", () => { if (innerWidth >= 1024) setMenu(false); });

  /* ---------- scroll-linked motion: native CSS timelines first ----------
     When the engine supports scroll-driven animations, the stylesheet drives
     --weld (weld-advance) and the hero parallax by itself. JS only writes the
     custom properties as a fallback for engines without support. */

  const cssScrollTimeline = CSS.supports("animation-timeline", "scroll()");
  const cssViewTimeline = CSS.supports("animation-timeline", "view()");

  // --weld also feeds the reduced-motion experience (no CSS animation there)
  const needWeldVar = !cssScrollTimeline || reducedMotion.matches;
  const needHeroVar = !cssViewTimeline && !reducedMotion.matches;

  let ticking = false;
  const hero = document.querySelector(".hero");

  const setScrollState = () => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 1;
    root.style.setProperty("--weld", p.toFixed(4));
    if (hero) {
      const hp = Math.min(1, Math.max(0, scrollY / Math.max(1, hero.offsetHeight * 0.85)));
      root.style.setProperty("--hero-p", hp.toFixed(4));
    }
    ticking = false;
  };

  if (needWeldVar || needHeroVar) {
    addEventListener("scroll", () => {
      if (!ticking) { ticking = true; requestAnimationFrame(setScrollState); }
    }, { passive: true });
    addEventListener("resize", setScrollState);
    setScrollState();
  }

  /* ---------- pass markers track the visible section ---------- */

  const railLinks = [...document.querySelectorAll(".rail-pass a")];
  const sections = railLinks
    .map((a) => document.getElementById(a.hash.slice(1)))
    .filter(Boolean);

  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((e) => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    railLinks.forEach((a) => a.setAttribute("aria-current", String(a.hash === `#${visible.target.id}`)));
  }, { rootMargin: "-25% 0px -55%", threshold: [0.05, 0.25, 0.5] });

  sections.forEach((s) => sectionObserver.observe(s));

  /* ---------- reveals ----------
     With view() timelines the stylesheet scrubs .reveal on its own;
     the observer is the fallback for engines without support. */

  if (!(cssViewTimeline && !reducedMotion.matches)) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-set");
        revealObserver.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -8%", threshold: 0.08 });

    document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
  }

  /* ---------- procedure sheet ----------
     In gallery mode (pinned horizontal scrub) every card is fully
     expanded and the accordion is inert; elsewhere it stays a sheet.
     State is re-synced when crossing the gallery breakpoint. */

  const galleryQuery = matchMedia("(min-width: 64rem)");
  const galleryActive = () =>
    cssViewTimeline && !reducedMotion.matches && galleryQuery.matches;

  const passRows = [...document.querySelectorAll(".pass-row")];

  const syncGalleryState = () => {
    if (!galleryActive()) return;
    passRows.forEach((row) => {
      row.dataset.open = "true";
      row.querySelector(".pass-summary")?.setAttribute("aria-expanded", "true");
    });
  };

  passRows.forEach((row) => {
    const btn = row.querySelector(".pass-summary");
    btn?.addEventListener("click", () => {
      if (galleryActive()) return;
      const open = row.dataset.open !== "true";
      row.dataset.open = String(open);
      btn.setAttribute("aria-expanded", String(open));
    });
  });

  syncGalleryState();
  galleryQuery.addEventListener("change", syncGalleryState);

  /* ---------- copy the weld log ---------- */

  const copyButton = document.getElementById("copy-command");
  const copyLabel = document.getElementById("copy-label");
  const copyStatus = document.getElementById("copy-status");

  copyButton?.addEventListener("click", async () => {
    const command = document.getElementById("setup-command");
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command.innerText.trim());
      copyStatus.textContent = "Commands copied.";
      if (copyLabel) copyLabel.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      copyStatus.textContent = "Commands selected. Copy them from the log.";
    }
    setTimeout(() => {
      if (copyLabel) copyLabel.textContent = "Copy";
      copyStatus.textContent = "";
    }, 2400);
  });
})();
