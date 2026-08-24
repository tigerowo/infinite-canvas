import { describe, expect, it } from "vitest";

import { isRunningHubReference, managedProviderProtocols } from "@/lib/provider";

describe("provider helpers", () => {
    it("accepts only explicit RunningHub app and workflow references", () => {
        expect(isRunningHubReference("app:2058517022748798977")).toBe(true);
        expect(isRunningHubReference("workflow:2058824859437850625")).toBe(true);
        expect(isRunningHubReference("2058824859437850625")).toBe(false);
        expect(isRunningHubReference("workflow:abc")).toBe(false);
    });

    it("keeps RunningHub out of OpenAI-compatible model channel syncing", () => {
        expect(managedProviderProtocols.has("runninghub")).toBe(false);
        expect(managedProviderProtocols.has("openai")).toBe(true);
    });
});
