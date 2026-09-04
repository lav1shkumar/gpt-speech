import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("Next security headers", () => {
  it("keeps production headers restrictive", async () => {
    const rules = await nextConfig.headers?.();
    const globalRule = rules?.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(
      globalRule?.headers.map(({ key, value }) => [key, value]) ?? [],
    );
    const csp = headers["Content-Security-Policy"];

    expect(nextConfig.poweredByHeader).toBe(false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain(" ws:");
    expect(csp).not.toContain(" wss:");
    expect(headers["Permissions-Policy"]).toContain("microphone=(self)");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=63072000");
  });
});
