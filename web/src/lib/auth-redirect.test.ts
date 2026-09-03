import { describe, expect, it } from "vitest";

import { safeInternalRedirect } from "@/lib/auth-redirect";

describe("safeInternalRedirect", () => {
    it("keeps an internal post-login destination", () => {
        expect(safeInternalRedirect("/providers")).toBe("/providers");
        expect(safeInternalRedirect("/canvas/project-1?mode=edit")).toBe("/canvas/project-1?mode=edit");
    });

    it("rejects absolute and protocol-relative destinations", () => {
        expect(safeInternalRedirect("https://example.test/providers")).toBe("/");
        expect(safeInternalRedirect("//example.test/providers")).toBe("/");
        expect(safeInternalRedirect("/\\example.test/providers")).toBe("/");
    });

    it("strips control characters before validating", () => {
        expect(safeInternalRedirect("/providers\r\n")).toBe("/providers");
        expect(safeInternalRedirect("/\t\\example.test")).toBe("/");
    });
});
