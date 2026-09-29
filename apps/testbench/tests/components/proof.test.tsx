import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ProofPanel } from "../../src/components/ProofPanel";
import { fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const FILE = {
  generatedAt: "2026-09-29T12:00:00.000Z",
  source: "celo-harness/MATRIX.md",
  matrixUpdated: "2026-09-28",
  sections: [
    {
      title: "Milestone 1",
      rows: [
        {
          item: "1a",
          title: "Contracts deployed",
          status: "Proven (live)",
          state: "proven-live",
          relay: "",
          note: "Plan-verified",
          links: [{ label: "0xeb47", url: "https://sepolia.celoscan.io/tx/0xeb47" }],
        },
        {
          item: "1c",
          title: "Published to npm",
          status: "Missing",
          state: "missing",
          relay: "",
          note: "npm is on 0.9.0",
          links: [],
        },
      ],
    },
    {
      title: "The spine",
      rows: [
        {
          item: "S3",
          title: "Register from Celo",
          status: "Proven (fork, funder check stubbed)",
          state: "proven-fork",
          relay: "fork",
          note: "Stub on",
          links: [],
        },
      ],
    },
  ],
};

function setup(body: unknown = FILE, status = 200) {
  const fetchImpl = vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      : new Response("nope", { status }),
  );
  renderWith(fakeClient(), <ProofPanel fetchImpl={fetchImpl as never} />);
  return { fetchImpl };
}

describe("ProofPanel", () => {
  test("renders each section's rows with the matrix's own status words", async () => {
    setup();
    expect(await screen.findByText("Contracts deployed")).toBeInTheDocument();
    expect(screen.getByText("Proven live")).toBeInTheDocument();
    // The qualified status is shown in full, not flattened to the badge.
    expect(screen.getByText("Proven (fork, funder check stubbed)")).toBeInTheDocument();
    expect(screen.getByText("Proven on a fork")).toBeInTheDocument();
  });

  test("summarises how many rows are in each state", async () => {
    setup();
    expect(await screen.findByText("1 proven live")).toBeInTheDocument();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("1 proven on a fork")).toBeInTheDocument();
  });

  test("says how many items a third party can check, and why a fork row has no link", async () => {
    setup();
    expect(await screen.findByText(/1 items carry a public transaction/)).toBeInTheDocument();
    expect(screen.getByText(/A fork transaction has no explorer/)).toBeInTheDocument();
    expect(screen.getAllByText("no public transaction").length).toBe(2);
  });

  test("filtering to public transactions hides the rows that have none", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: /only items with a public transaction/ }));
    expect(screen.getByText("Contracts deployed")).toBeInTheDocument();
    expect(screen.queryByText("Published to npm")).not.toBeInTheDocument();
    // And a section with nothing left disappears rather than showing an empty table.
    expect(screen.queryByText("The spine")).not.toBeInTheDocument();
  });

  test("links go to the explorer", async () => {
    setup();
    const link = await screen.findByRole("link", { name: "0xeb47" });
    expect(link).toHaveAttribute("href", "https://sepolia.celoscan.io/tx/0xeb47");
  });

  test("says when it was generated, so a stale checklist is not read as today", async () => {
    setup();
    expect(await screen.findByText(/from a matrix last updated 2026-09-28/)).toBeInTheDocument();
  });

  test("a missing file says how to generate one", async () => {
    setup(undefined, 404);
    expect(await screen.findByRole("alert")).toHaveTextContent(/build-proof\.mjs/);
  });

  test("a file of the wrong shape is refused rather than half rendered", async () => {
    setup({ nope: true });
    expect(await screen.findByRole("alert")).toHaveTextContent(/not in the shape this view expects/);
    expect(screen.queryByText("Where this stands")).not.toBeInTheDocument();
  });
});
