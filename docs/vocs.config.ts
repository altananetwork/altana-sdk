import { createElement, Fragment } from "react";
import { defineConfig } from "vocs";

// Vocs injects `<base href={baseUrl}>` into every page whenever the build is
// non-localhost. That makes every relative URL on the page (images, internal
// links) resolve against baseUrl instead of the host actually serving the
// page. Fine on the real production domain; on a Vercel preview/staging
// deploy it 404s local assets and sends internal link clicks to the live
// production site instead of navigating client-side. Only set baseUrl for
// the actual production deploy so previews resolve against themselves.
const baseUrl =
  process.env.VERCEL_ENV === "production"
    ? "https://docs.altana.network"
    : undefined;

export default defineConfig({
  title: "Altana",
  titleTemplate: "%s · Altana",
  description:
    "Noncustodial authorization infrastructure for agentic workflows. Give agents provable, revocable authority to act onchain, scoped by policy you control and verifiable by anyone.",
  rootDir: ".",
  baseUrl,
  ogImageUrl:
    "https://vocs.dev/api/og?logo=%logo&title=%title&description=%description",
  editLink: {
    pattern:
      "https://github.com/altananetwork/altana-sdk/edit/main/docs/pages/:path",
    text: "Suggest changes to this page",
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
      link: "https://github.com/altananetwork/altana-sdk",
    },
  ],
  topNav: [
    { text: "Get started", link: "/getting-started/create-agentic-wallet" },
    { text: "Guides", link: "/use-cases" },
    { text: "Explorer", link: "/explorer" },
    { text: "SDK", link: "/sdk" },
    { text: "MCP", link: "/mcp" },
    { text: "Skills", link: "/skills" },
  ],
  sidebar: [
    { text: "Welcome", link: "/", items: [] },
    {
      text: "Get Started",
      items: [
        { text: "Create a smart agentic wallet", link: "/getting-started/create-agentic-wallet" },
        { text: "Passkey wallet quickstart", link: "/getting-started/passkey" },
        { text: "Private key wallet quickstart", link: "/getting-started/private-key" },
        { text: "Connect an AI tool", link: "/getting-started/build-with-claude" },
      ],
    },
    {
      text: "Guides",
      items: [
        { text: "Overview", link: "/use-cases" },
        { text: "Private key: agent wallet and policy", link: "/use-cases/1-agent-wallet-policy" },
        { text: "Passkey: agent wallet and policy", link: "/use-cases/1b-passkey-delegates-to-agent" },
        { text: "Let an agent trade on a DEX", link: "/use-cases/2-agent-trades-dex" },
        { text: "Run a portfolio with multiple agents", link: "/use-cases/3-portfolio-multiple-agents" },
        { text: "Verify agent authority", link: "/use-cases/4-verify-agent-authority" },
        { text: "Authorize across chains", link: "/use-cases/5-cross-chain-authorization" },
        { text: "Pay for an API with x402", link: "/use-cases/6-agent-pays-api-x402" },
        { text: "Onboard users from browser wallets", link: "/use-cases/7-onboard-from-browser-wallets" },
        { text: "Use the SDK in a mobile app", link: "/use-cases/8-mobile-app" },
      ],
    },
    {
      text: "SDK Reference",
      items: [
        { text: "Overview", link: "/sdk" },
        { text: "Setup: BNB Smart Chain", link: "/sdk/bnb" },
        { text: "Setup: BNB Testnet", link: "/sdk/bnb-testnet" },
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
            { text: "Errors", link: "/sdk/errors" },
          ],
        },
        {
          text: "Reads & Chains",
          items: [
            { text: "balances", link: "/sdk/balances" },
            { text: "ensureKeyCached", link: "/sdk/sync-to-l2" },
          ],
        },
        {
          text: "Payments & Signing",
          items: [
            { text: "x402 payments", link: "/sdk/x402" },
            { text: "Sell over x402", link: "/sdk/x402-server" },
            { text: "ERC-8183: hire BNB agents", link: "/sdk/erc8183" },
            { text: "ERC-8004: agent identity", link: "/sdk/erc8004" },
            { text: "signOrder", link: "/sdk/sign-order" },
            { text: "approveSignatureChecker", link: "/sdk/approve-signature-checker" },
            { text: "approveTokenForPermit2", link: "/sdk/approve-permit2" },
          ],
        },
      ],
    },
    {
      text: "Networks & Addresses",
      items: [
        { text: "Mainnet", link: "/concepts/networks" },
        { text: "Testnet", link: "/concepts/networks/testnet" },
      ],
    },
    { text: "Keystore Explorer", link: "/explorer", items: [] },
    {
      text: "Security",
      items: [{ text: "Audit reports", link: "/security/audits" }],
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
      text: "Skills Registry",
      items: [
        { text: "Overview", link: "/skills" },
        { text: "Submit a skill", link: "/skills/submit" },
      ],
    },
    {
      text: "Concepts",
      collapsed: true,
      items: [
        { text: "Keystore", link: "/concepts/keystore" },
        { text: "Sessions", link: "/concepts/sessions" },
        { text: "Off-chain signatures", link: "/concepts/off-chain-signatures" },
      ],
    },
    {
      text: "About",
      collapsed: true,
      items: [
        { text: "Why Altana", link: "/why-altana" },
        { text: "How Altana is different", link: "/concepts/comparison" },
        { text: "Changelog", link: "/changelog" },
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
