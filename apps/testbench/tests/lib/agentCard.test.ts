import { describe, expect, test, vi } from "vitest";
import { agentCardUrl, draftAgentRecord, isRegistrationRecord, loadAgentRecord } from "../../src/lib/agentCard";

const RECORD = { name: "Altana Wallet Agent", description: "Agentic wallets on Celo", version: "1.0.0" };
const DATA_URI = `data:application/json;base64,${btoa(JSON.stringify(RECORD))}`;

describe("loadAgentRecord", () => {
  test("decodes a data URI without leaving the browser", async () => {
    const fetchImpl = vi.fn();
    const { record, problem } = await loadAgentRecord(DATA_URI, fetchImpl as never);
    expect(problem).toBeUndefined();
    expect(record).toMatchObject(RECORD);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fetches an http record", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(RECORD), { status: 200 }));
    const { record } = await loadAgentRecord("https://docs.altana.network/.well-known/agent-card.json", fetchImpl as never);
    expect(record?.name).toBe("Altana Wallet Agent");
  });

  test("a 404 on the record's URL does not make the identity look broken", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const { record, problem } = await loadAgentRecord("https://docs.altana.network/.well-known/agent-card.json", fetchImpl as never);
    expect(record).toBeUndefined();
    expect(problem).toContain("answered 404");
    expect(problem).toContain("on-chain record is still there");
  });

  test("malformed JSON is reported rather than thrown", async () => {
    const { problem } = await loadAgentRecord(`data:application/json;base64,${btoa("{oops")}`);
    expect(problem).toBeTruthy();
  });

  test("a URI that is neither shape is named", async () => {
    const { problem } = await loadAgentRecord("ipfs://something");
    expect(problem).toContain("neither a data URI nor an http URL");
  });

  test("a network failure is reported rather than thrown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const { problem } = await loadAgentRecord("https://example.invalid/card.json", fetchImpl as never);
    expect(problem).toBe("fetch failed");
  });
});

describe("draftAgentRecord", () => {
  test("produces a data URI whose registrations are empty, since the id is not known yet", async () => {
    const uri = draftAgentRecord({ name: "Test bench agent", description: "d" });
    const { record } = await loadAgentRecord(uri);
    expect(record).toMatchObject({ name: "Test bench agent", registrations: [] });
  });
});

describe("the two record shapes", () => {
  const registration = {
    name: "Altana Wallet Agent",
    services: [
      { name: "MCP", endpoint: "https://docs.altana.network/.well-known/agent-card.json" },
      { name: "docs", endpoint: "https://docs.altana.network" },
    ],
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    raw: "",
  };

  test("a registration record is told from an agent card", () => {
    expect(isRegistrationRecord(registration)).toBe(true);
    expect(isRegistrationRecord({ name: "x", skills: [], version: "1", raw: "" })).toBe(false);
  });

  test("the card endpoint is found among the services, not just the first one", () => {
    // The docs service comes second and is not the card; picking blind would
    // send the operator to the wrong page.
    expect(agentCardUrl(registration)).toBe("https://docs.altana.network/.well-known/agent-card.json");
  });

  test("an A2A card's own url serves as the endpoint when there are no services", () => {
    expect(agentCardUrl({ url: "https://example.test/card.json", raw: "" })).toBe(
      "https://example.test/card.json",
    );
  });

  test("a record naming neither gives nothing rather than an empty link", () => {
    expect(agentCardUrl({ name: "x", raw: "" })).toBeUndefined();
    expect(agentCardUrl({ services: [{ name: "docs", endpoint: "https://docs.example" }], raw: "" })).toBeUndefined();
  });
});
