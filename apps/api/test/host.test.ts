import { describe, expect, it } from "vitest";
import { resolveTenantSlugFromHostname } from "../src/lib/host.js";

describe("resolveTenantSlugFromHostname", () => {
  it("ignora os subdominios reservados da plataforma", () => {
    expect(resolveTenantSlugFromHostname("admin.wa.infracode.pro", "wa.infracode.pro", "admin")).toBeUndefined();
    expect(resolveTenantSlugFromHostname("api.wa.infracode.pro", "wa.infracode.pro", "admin")).toBeUndefined();
  });

  it("resolve o slug de um tenant valido", () => {
    expect(resolveTenantSlugFromHostname("acme.wa.infracode.pro", "wa.infracode.pro", "admin")).toBe("acme");
  });
});
