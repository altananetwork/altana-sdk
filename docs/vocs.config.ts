import { createElement, Fragment } from "react";
import { defineConfig } from "vocs";

export default defineConfig({
  title: "Altana",
  titleTemplate: "%s · Altana",
  description:
    "Non-custodial agentic wallets with onchain session-key delegation.",
  rootDir: ".",
  // aiCta: true (default) keeps the aside rendering on every page.
  // We transform the ChatGPT link in-place via CSS + a click interceptor.
  // Vercel Web Analytics. Vocs renders `head` to static HTML, so we inject the
  // analytics script directly (the @vercel/analytics React component needs a
  // client root Vocs doesn't expose). Vercel serves this script and tracks
  // page views + SPA navigations once Web Analytics is enabled for the project.
  head: () =>
    createElement(
      Fragment,
      null,
      createElement("script", {
        key: "analytics",
        defer: true,
        src: "/_vercel/insights/script.js",
      }),
      // Transform "Ask in ChatGPT" into "Copy page for AI" using CSS only —
      // no DOM insertion so React reconciliation can't interfere.
      createElement(
        "style",
        { key: "copy-ai-style" },
        `
          /* Hide the chevron/dropdown button */
          a[href*="chatgpt.com"] + button { display: none !important; }

          /* Standalone button appearance */
          a[href*="chatgpt.com"] {
            border-top-right-radius: 6px !important;
            border-bottom-right-radius: 6px !important;
            width: 160px !important;
            gap: 0 !important;
          }

          /* Hide React-rendered children: the OpenAI SVG wrapper */
          a[href*="chatgpt.com"] > div { display: none !important; }

          /* Collapse the "Ask in ChatGPT" text node */
          a[href*="chatgpt.com"] { font-size: 0 !important; }

          /* Clipboard icon via ::before */
          a[href*="chatgpt.com"]::before {
            content: '';
            display: inline-block;
            width: 14px;
            height: 14px;
            flex-shrink: 0;
            margin-right: 6px;
            background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='9' width='13' height='13' rx='2' ry='2'%3E%3C/rect%3E%3Cpath d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'%3E%3C/path%3E%3C/svg%3E") no-repeat center / contain;
          }

          /* "Copy page for AI" label via ::after */
          a[href*="chatgpt.com"]::after {
            content: 'Copy page for AI';
            font-size: 12px;
            font-weight: 500;
          }

          /* Copied state: swap icon + label */
          a[href*="chatgpt.com"].ai-copied::before {
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
          }
          a[href*="chatgpt.com"].ai-copied::after { content: 'Copied'; }

          /* Altana CTA buttons — brand blue (#3665E4) with a darker pressed state */
          .altana-cta:not(:disabled):hover { background: #2f57cf !important; }
          .altana-cta:not(:disabled):active { background: #2647ad !important; }
        `,
      ),
      // Intercept clicks: preventDefault stops ChatGPT navigation,
      // then copies article text and shows the Copied state.
      // MutationObserver re-patches after SPA route changes (new <a> element).
      createElement(
        "script",
        { key: "copy-ai-script" },
        `
          (function() {
            function patch(link) {
              if (link._patched) return;
              link._patched = true;
              link.addEventListener('click', function(e) {
                e.preventDefault();
                var el = document.querySelector('article') || document.querySelector('main') || document.body;
                navigator.clipboard.writeText(el.innerText).then(function() {
                  link.classList.add('ai-copied');
                  setTimeout(function() { link.classList.remove('ai-copied'); }, 1500);
                });
              });
            }

            function findAndPatch() {
              var link = document.querySelector('a[href*="chatgpt.com"]');
              if (link) patch(link);
            }

            findAndPatch();

            var obs = new MutationObserver(findAndPatch);
            function startObs() { obs.observe(document.body, { childList: true, subtree: true }); }
            if (document.body) startObs();
            else document.addEventListener('DOMContentLoaded', startObs);
          })();
        `,
      ),
    ),
  iconUrl: "/favicon.svg",
  logoUrl: {
    light: "/logo-light.svg",
    dark: "/logo-dark.svg",
  },
  socials: [
    {
      icon: "github",
      link: "https://github.com/altananetwork/sdk",
    },
  ],
  topNav: [
    { text: "Docs", link: "/sdk/bnb" },
    { text: "SDK", link: "/sdk/create-wallet" },
    { text: "MCP", link: "/mcp" },
    { text: "GitHub", link: "https://github.com/altananetwork/sdk" },
  ],
  sidebar: [
    {
      text: "Home",
      items: [
        { text: "Welcome", link: "/" },
      ],
    },
    {
      text: "Getting Started",
      items: [
        { text: "Create an agentic wallet", link: "/getting-started/create-agentic-wallet" },
        { text: "Connect an AI tool", link: "/getting-started/build-with-claude" },
      ],
    },
    {
      text: "Build with Altana",
      items: [
        { text: "Overview", link: "/use-cases" },
        { text: "1. Give an agent a wallet and a policy", link: "/use-cases/1-agent-wallet-policy" },
        { text: "↳ 1b. Use a passkey as admin", link: "/use-cases/1b-passkey-delegates-to-agent" },
        ...(process.env.NODE_ENV === 'development' ? [
          { text: "2. Let an agent trade on a DEX", link: "/use-cases/2-agent-trades-dex" },
          { text: "3. Run a multi-agent portfolio", link: "/use-cases/3-portfolio-multiple-agents" },
          { text: "4. Verify agent authority", link: "/use-cases/4-verify-agent-authority" },
          { text: "5. Authorize across chains", link: "/use-cases/5-cross-chain-authorization" },
        ] : [
          { text: "2. Let an agent trade on a DEX" },
          { text: "3. Run a multi-agent portfolio" },
          { text: "4. Verify agent authority" },
          { text: "5. Authorize across chains" },
        ]),
      ],
    },
    {
      text: "SDK",
      items: [
        { text: "BNB Smart Chain", link: "/sdk/bnb" },
        { text: "createPasskeyWallet", link: "/sdk/create-passkey-wallet" },
        { text: "createWallet", link: "/sdk/create-wallet" },
        { text: "execute", link: "/sdk/execute" },
        { text: "grantSession", link: "/sdk/grant-session" },
        { text: "revokeSession", link: "/sdk/revoke-session" },
        { text: "balances", link: "/sdk/balances" },
        { text: "ensureKeyCached", link: "/sdk/sync-to-l2" },
        { text: "recoverFromPasskey", link: "/sdk/recover-from-passkey" },
      ],
    },
    {
      text: "MCP Server",
      items: [
        { text: "Overview", link: "/mcp" },
        { text: "Install", link: "/mcp/install" },
        { text: "Tools", link: "/mcp/tools" },
        { text: "↳ Claude Skill", link: "/mcp/skill" },
      ],
    },
    {
      text: "Learn More",
      items: [
        { text: "Why Altana", link: "/why-altana" },
        { text: "How is it different", link: "/concepts/comparison" },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "Keystore", link: "/concepts/keystore" },
        { text: "Sessions", link: "/concepts/sessions" },
        { text: "Networks & Addresses", link: "/concepts/networks" },
      ],
    },
    {
      text: "Acknowledgments",
      link: "/acknowledgments",
    },
  ],
  theme: {
    accentColor: {
      light: "#3665E4",
      dark: "#6b8fff",
    },
  },
});
