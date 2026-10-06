import { describe, expect, it } from "vitest";
import { intentCanonical, roleInputsCanonical } from "./rankingInputs.js";

/**
 * CROSS-LANGUAGE CONTRACT. These arrays are compared for EQUALITY by the ranked
 * SQL, which aggregates candidate_selected_roles into the same shape. The SQL
 * parity fixture (supabase/tests/database/ranked_opportunities_parity.test.sql,
 * UNEXECUTED) asserts the two agree for the same rows; these tests pin the shape.
 */

describe("roleInputsCanonical", () => {
  it("sorts by role_name and carries only the role", () => {
    expect(roleInputsCanonical([{ roleName: "Teacher" }, { roleName: "Data Engineer" }])).toEqual([
      { role_name: "Data Engineer" },
      { role_name: "Teacher" },
    ]);
  });

  it("is order-independent and empty when no roles are selected", () => {
    const a = roleInputsCanonical([{ roleName: "A" }, { roleName: "B" }]);
    const b = roleInputsCanonical([{ roleName: "B" }, { roleName: "A" }]);
    expect(a).toEqual(b);
    expect(roleInputsCanonical([])).toEqual([]);
  });
});

describe("intentCanonical", () => {
  it("normalises NULL raw intent to the empty string, exactly as intentFingerprintOf does", () => {
    expect(intentCanonical([{ roleName: "Data Engineer", rawRoleName: null }])).toEqual([
      { role_name: "Data Engineer", raw_role_name: "" },
    ]);
    expect(intentCanonical([{ roleName: "Data Engineer", rawRoleName: "" }])).toEqual([
      { role_name: "Data Engineer", raw_role_name: "" },
    ]);
  });

  it("sorts by (role_name, raw_role_name) and preserves the recorded phrase", () => {
    expect(
      intentCanonical([
        { roleName: "Teacher", rawRoleName: "Maths Teacher" },
        { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
        { roleName: "Data Engineer", rawRoleName: "Data Engineer" },
      ]),
    ).toEqual([
      { role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" },
      { role_name: "Data Engineer", raw_role_name: "Data Engineer" },
      { role_name: "Teacher", raw_role_name: "Maths Teacher" },
    ]);
  });

  it("tolerates an input with no raw phrase at all", () => {
    expect(intentCanonical([{ roleName: "Data Engineer" }])).toEqual([
      { role_name: "Data Engineer", raw_role_name: "" },
    ]);
  });
});
