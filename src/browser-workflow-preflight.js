// KMJ Work-like browser flow stage 0: deterministic plan ONLY.
// The existing Moli/Chrome QA executor does not own an authenticated profile.
// Never accept arbitrary URLs, JavaScript, cookies, credentials or billing actions.
const WORKFLOWS = Object.freeze({
  brevo_domain_auth: Object.freeze({
    title: "KMJ Mail Brevo Free sender-domain setup",
    origin: "https://app.brevo.com",
    domain: "kmjtechno.com",
    stages: Object.freeze([
      ["check_free_plan", "read", "Confirm free plan; reject subscription upgrades"],
      ["sign_in", "owner", "Owner signs in using isolated private browser profile"],
      ["open_domains", "read", "Find sender domains without exposing session data"],
      ["add_domain", "approval", "Register kmjtechno.com as a sender domain"],
      ["review_dns", "read", "Capture only provider-issued public DNS record names and values"],
      ["apply_dns", "approval", "Apply specific approved records via scoped Cloudflare API"],
      ["verify_domain", "read", "Recheck provider domain authentication"],
      ["smtp_activation", "approval", "Create/activate secret into server-side secret store, never chat"],
      ["send_test", "approval", "Send one owner-consented inbox test, verify actual receipt"],
    ]),
  }),
});

export function browserWorkflowPreflight(workflow) {
  if (typeof workflow !== "string" ||
      !Object.hasOwn(WORKFLOWS, workflow)) {
    throw Error("BROWSER_WORKFLOW_NOT_ALLOWLISTED");
  }
  const spec = WORKFLOWS[workflow];
  return {
    schema: "kmj-browser-workflow-preflight-v1",
    workflow,
    title: spec.title,
    engineCandidate: "moli-cdp-or-chrome",
    mode: "PLAN_ONLY",
    site: { origin: spec.origin, senderDomain: spec.domain },
    authenticatedSession: "NOT_ATTACHED",
    execution: "NOT_STARTED",
    ownerApprovalRequired: true,
    forbidden: [
      "paid_plan_or_subscription",
      "unapproved_dns_changes",
      "credentials_otp_cookie_or_token_export",
      "public_debugging_port",
      "arbitrary_url_or_script",
      "bulk_customer_email",
      "bypass_captcha_or_mfa",
    ],
    stages: spec.stages.map(([id, mode, purpose], index) => ({
      id,
      order: index + 1,
      mode,
      purpose,
      status: "NOT_STARTED",
    })),
    nextGate: "OWNER_SESSION_AND_APPROVAL_CONTROL_NOT_IMPLEMENTED",
    readyToExecute: false,
  };
}
