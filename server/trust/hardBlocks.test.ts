import { describe, expect, it } from "vitest";
import { evaluateHardBlocks, type HardBlockSignals } from "./hardBlocks.js";

const cleanSignals: HardBlockSignals = {
  authoritativeUrl: "https://careers.acme.com/jobs/123",
  companyDomain: "acme.com",
  companyCareerDomain: "careers.acme.com",
  sourceDiscoveryAllowed: true,
  sourceKillSwitch: false,
  vacancyStatus: "active",
};

describe("evaluateHardBlocks", () => {
  it("returns no reason codes when every signal is clean", () => {
    expect(evaluateHardBlocks(cleanSignals)).toEqual([]);
  });

  describe("VACANCY_REMOVED", () => {
    it("triggers when the vacancy has been removed at the source", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, vacancyStatus: "removed" })).toContain("VACANCY_REMOVED");
    });

    it("does not trigger for a merely expired (not removed) vacancy", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, vacancyStatus: "expired" })).not.toContain("VACANCY_REMOVED");
    });
  });

  describe("UNAUTHORIZED_SOURCE_ACCESS", () => {
    it("triggers when discovery is not allowed for the source", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, sourceDiscoveryAllowed: false })).toContain(
        "UNAUTHORIZED_SOURCE_ACCESS",
      );
    });

    it("triggers when the source's kill switch is engaged", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, sourceKillSwitch: true })).toContain(
        "UNAUTHORIZED_SOURCE_ACCESS",
      );
    });

    it("does not trigger when discovery is allowed and the kill switch is off", () => {
      expect(evaluateHardBlocks(cleanSignals)).not.toContain("UNAUTHORIZED_SOURCE_ACCESS");
    });
  });

  describe("DOMAIN_MISMATCH_WITH_NO_EXPLANATION and COMPANY_IMPERSONATION", () => {
    it("flags DOMAIN_MISMATCH_WITH_NO_EXPLANATION for a wholly unrelated hosting domain", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://randomjobsite.example/post/999",
      };
      const result = evaluateHardBlocks(signals);
      expect(result).toContain("DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
      expect(result).not.toContain("COMPANY_IMPERSONATION");
    });

    it("flags COMPANY_IMPERSONATION for a lookalike domain embedding the real label", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://acme-careers-now.net/jobs/1",
      };
      const result = evaluateHardBlocks(signals);
      expect(result).toContain("COMPANY_IMPERSONATION");
      expect(result).not.toContain("DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
    });

    it("flags COMPANY_IMPERSONATION for a close typo of the real domain label", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://acmee.com/jobs/1",
      };
      expect(evaluateHardBlocks(signals)).toContain("COMPANY_IMPERSONATION");
    });

    it("does not flag either when the hostname matches the career domain exactly", () => {
      expect(evaluateHardBlocks(cleanSignals)).not.toContain("DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
    });

    it("matches a www. prefix against the known domain without flagging it", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://www.careers.acme.com/jobs/1",
      };
      expect(evaluateHardBlocks(signals)).toEqual([]);
    });

    it("is case-insensitive when comparing hostname to known domains", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://Careers.ACME.com/jobs/1",
      };
      expect(evaluateHardBlocks(signals)).toEqual([]);
    });

    it("skips the domain check entirely when no company domain is known yet", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        authoritativeUrl: "https://randomjobsite.example/post/999",
        companyDomain: null,
        companyCareerDomain: null,
      };
      const result = evaluateHardBlocks(signals);
      expect(result).not.toContain("DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
      expect(result).not.toContain("COMPANY_IMPERSONATION");
    });

    it("does not crash on a malformed authoritative URL", () => {
      const signals: HardBlockSignals = { ...cleanSignals, authoritativeUrl: "not-a-url" };
      expect(() => evaluateHardBlocks(signals)).not.toThrow();
      expect(evaluateHardBlocks(signals)).not.toContain("DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
    });
  });

  describe("PHISHING_OR_MALWARE_REDIRECT", () => {
    it("triggers when the redirect target does not use TLS", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, redirectIsTls: false })).toContain(
        "PHISHING_OR_MALWARE_REDIRECT",
      );
    });

    it("triggers when the final redirect URL is unparseable", () => {
      const signals: HardBlockSignals = { ...cleanSignals, finalRedirectUrl: "ht!tp://[bad" };
      expect(evaluateHardBlocks(signals)).toContain("PHISHING_OR_MALWARE_REDIRECT");
    });

    it("does not trigger when no redirect signal is present at all", () => {
      expect(evaluateHardBlocks(cleanSignals)).not.toContain("PHISHING_OR_MALWARE_REDIRECT");
    });

    it("does not trigger for a clean, TLS-verified redirect", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        finalRedirectUrl: "https://careers.acme.com/jobs/123",
        redirectIsTls: true,
      };
      expect(evaluateHardBlocks(signals)).not.toContain("PHISHING_OR_MALWARE_REDIRECT");
    });
  });

  describe("PAYMENT_OR_FEE_REQUEST", () => {
    it("triggers on a registration-fee scam pattern", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "To secure your position, a small registration fee is required before you start.",
      };
      expect(evaluateHardBlocks(signals)).toContain("PAYMENT_OR_FEE_REQUEST");
    });

    it("triggers on a 'pay to start' pattern", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Candidates must pay $50 to start their onboarding kit.",
      };
      expect(evaluateHardBlocks(signals)).toContain("PAYMENT_OR_FEE_REQUEST");
    });

    it("does not trigger for a normal job description", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "We are hiring a backend engineer to join our platform team.",
      };
      expect(evaluateHardBlocks(signals)).not.toContain("PAYMENT_OR_FEE_REQUEST");
    });

    it("does not evaluate when no description text is available", () => {
      expect(evaluateHardBlocks(cleanSignals)).not.toContain("PAYMENT_OR_FEE_REQUEST");
    });
  });

  describe("MLM_OR_PYRAMID_RISK", () => {
    it("triggers on an explicit pyramid/MLM pattern", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Join our team and recruit 5 people to unlock the next commission tier.",
      };
      expect(evaluateHardBlocks(signals)).toContain("MLM_OR_PYRAMID_RISK");
    });

    it("triggers on a 'starter kit' pattern", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Purchase your starter kit today and begin selling to friends and family.",
      };
      expect(evaluateHardBlocks(signals)).toContain("MLM_OR_PYRAMID_RISK");
    });

    it("does not trigger for a normal sales role description", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "We are hiring an account executive for our enterprise sales team.",
      };
      expect(evaluateHardBlocks(signals)).not.toContain("MLM_OR_PYRAMID_RISK");
    });
  });

  describe("PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST", () => {
    it("triggers when bank account details are requested up front", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Please provide your bank account number and routing number to proceed with the application.",
      };
      expect(evaluateHardBlocks(signals)).toContain("PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST");
    });

    it("triggers when a government ID number is requested up front", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Applicants must submit their social security number before scheduling an interview.",
      };
      expect(evaluateHardBlocks(signals)).toContain("PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST");
    });

    it("does not trigger for a normal application requirements list", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Please submit your resume and a cover letter to apply.",
      };
      expect(evaluateHardBlocks(signals)).not.toContain("PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST");
    });
  });

  describe("PROHIBITED_OR_ILLEGAL_REQUIREMENT", () => {
    it("triggers on a 'no experience, guaranteed high pay' scam pattern", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "No experience needed, earn $500 guaranteed income daily working from home.",
      };
      expect(evaluateHardBlocks(signals)).toContain("PROHIBITED_OR_ILLEGAL_REQUIREMENT");
    });

    it("does not trigger for a normal entry-level posting", () => {
      const signals: HardBlockSignals = {
        ...cleanSignals,
        descriptionText: "Entry-level role, no prior experience required, competitive salary based on location.",
      };
      expect(evaluateHardBlocks(signals)).not.toContain("PROHIBITED_OR_ILLEGAL_REQUIREMENT");
    });
  });

  describe("CONFIRMED_MODERATOR_BLOCK", () => {
    it("triggers when a moderator has already recorded a block", () => {
      expect(evaluateHardBlocks({ ...cleanSignals, priorModeratorBlock: true })).toContain(
        "CONFIRMED_MODERATOR_BLOCK",
      );
    });

    it("does not trigger when no prior moderator decision exists", () => {
      expect(evaluateHardBlocks(cleanSignals)).not.toContain("CONFIRMED_MODERATOR_BLOCK");
    });
  });

  it("returns every triggered code when multiple hard blocks fire simultaneously", () => {
    const signals: HardBlockSignals = {
      ...cleanSignals,
      vacancyStatus: "removed",
      sourceKillSwitch: true,
      descriptionText: "A small registration fee is required before you can start.",
    };
    const result = evaluateHardBlocks(signals);
    expect(result).toContain("VACANCY_REMOVED");
    expect(result).toContain("UNAUTHORIZED_SOURCE_ACCESS");
    expect(result).toContain("PAYMENT_OR_FEE_REQUEST");
    expect(result).toHaveLength(3);
  });
});
