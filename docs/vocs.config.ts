import { createElement, Fragment } from "react";
import { defineConfig } from "vocs";

export default defineConfig({
  title: "Altana",
  titleTemplate: "%s · Altana",
  description:
    "Noncustodial infrastructure that lets AI agents pay, invest, and operate. Safely.",
  rootDir: ".",
  baseUrl: "https://docs.altana.network",
  ogImageUrl:
    "https://vocs.dev/api/og?logo=%logo&title=%title&description=%description",
  editLink: {
    pattern:
      "https://github.com/altananetwork/altana-sdk/edit/main/docs/pages/:path",
    text: "Edit this page",
  },
  font: {
    google: "Inter Tight",
  },
  // aiCta: true (default) keeps the aside rendering on every page.
  // Its "Ask in ChatGPT" link is restyled into "Copy page for AI" in
  // styles.css; the click interceptor below supplies the behavior.
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
    { text: "Get started", link: "/getting-started/create-agentic-wallet" },
    { text: "Guides", link: "/use-cases" },
    { text: "SDK", link: "/sdk/bnb" },
    { text: "MCP", link: "/mcp" },
  ],
  sidebar: [
    { text: "Welcome", link: "/" },
    {
      text: "Get Started",
      items: [
        { text: "Create an agentic wallet", link: "/getting-started/create-agentic-wallet" },
        { text: "Passkey wallet quickstart", link: "/getting-started/passkey" },
        { text: "Private key wallet quickstart", link: "/getting-started/private-key" },
        { text: "Connect an AI tool", link: "/getting-started/build-with-claude" },
      ],
    },
    {
      text: "Guides",
      items: [
        { text: "Overview", link: "/use-cases" },
        { text: "Give an agent a wallet and a policy", link: "/use-cases/1-agent-wallet-policy" },
        { text: "Use a passkey as admin", link: "/use-cases/1b-passkey-delegates-to-agent" },
        { text: "Let an agent trade on a DEX", link: "/use-cases/2-agent-trades-dex" },
        { text: "Run a portfolio with multiple agents", link: "/use-cases/3-portfolio-multiple-agents" },
        { text: "Verify agent authority", link: "/use-cases/4-verify-agent-authority" },
        { text: "Authorize across chains", link: "/use-cases/5-cross-chain-authorization" },
      ],
    },
    {
      text: "SDK Reference",
      items: [
        { text: "Setup: BNB Smart Chain", link: "/sdk/bnb" },
        {
          text: "Wallets",
          items: [
            { text: "createWallet", link: "/sdk/create-wallet" },
            { text: "createPasskeyWallet", link: "/sdk/create-passkey-wallet" },
            { text: "recoverFromPasskey", link: "/sdk/recover-from-passkey" },
          ],
        },
        {
          text: "Sessions & Execution",
          items: [
            { text: "grantSession", link: "/sdk/grant-session" },
            { text: "execute", link: "/sdk/execute" },
            { text: "revokeSession", link: "/sdk/revoke-session" },
          ],
        },
        {
          text: "Reads & Chains",
          items: [
            { text: "balances", link: "/sdk/balances" },
            { text: "ensureKeyCached", link: "/sdk/sync-to-l2" },
          ],
        },
      ],
    },
    {
      text: "MCP Server",
      items: [
        { text: "Overview", link: "/mcp" },
        { text: "Install", link: "/mcp/install" },
        { text: "Tools", link: "/mcp/tools" },
        { text: "Claude Skill", link: "/mcp/skill" },
      ],
    },
    {
      text: "Concepts",
      collapsed: true,
      items: [
        { text: "Keystore", link: "/concepts/keystore" },
        { text: "Sessions", link: "/concepts/sessions" },
        { text: "Networks & Addresses", link: "/concepts/networks" },
      ],
    },
    {
      text: "About",
      collapsed: true,
      items: [
        { text: "Why Altana", link: "/why-altana" },
        { text: "How Altana is different", link: "/concepts/comparison" },
        { text: "Acknowledgments", link: "/acknowledgments" },
      ],
    },
  ],
  theme: {
    accentColor: {
      light: "#3665E4",
      dark: "#6b8fff",
    },
    variables: {
      fontWeight: {
        regular: "400",
        medium: "500",
        semibold: "600",
      },
    },
  },
});
