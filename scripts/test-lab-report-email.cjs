/*
 * Isolated end-to-end test for automatic lab-report email delivery.
 *
 * Runs the real backend against a LOCAL test database and a fake SMTP server.
 * Refuses to run against anything that is not a local hms_*_test database.
 * Never used by the application itself.
 */
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const jwt = require("jsonwebtoken");
const { startFakeSmtp } = require("./fake-smtp-server.cjs");

const backendDir = path.resolve(__dirname, "..");
const tempDir = path.join(process.env.TEMP || process.env.TMP || backendDir, "hms-email-e2e");
const outboxDir = path.join(tempDir, "outbox");
const modeFile = path.join(tempDir, "smtp-mode.txt");
const backendLog = path.join(tempDir, "backend.log");

const SMTP_PORT = 2525;
const API_PORT = 5055;
const BASE = `http://127.0.0.1:${API_PORT}`;

const readEnvFile = (file) => {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^=#]+)=(.*)$/);
    if (!match) continue;
    values[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
};

const appEnv = readEnvFile(path.join(backendDir, ".env"));
const testEnv = readEnvFile(path.join(backendDir, ".env.test.local"));
if (!testEnv.DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.test.local");
  process.exit(1);
}

/* .env.test.local holds the isolated cluster credentials. The e2e database is
   the restored production backup plus the email migration, so it is selected
   explicitly and never the app's default database. */
const TEST_DATABASE = process.env.HMS_EMAIL_TEST_DATABASE || "hms_email_test_20261117";
const testDbUrl = new URL(testEnv.DATABASE_URL);
testDbUrl.pathname = `/${TEST_DATABASE}`;
const databaseUrl = testDbUrl.toString();

const parsedDb = new URL(databaseUrl);
const isLocal = ["127.0.0.1", "localhost"].includes(parsedDb.hostname);
const isTestDb = /^\/hms_(email_test|new_lab_walkin_test)/.test(parsedDb.pathname);
if (!isLocal || !isTestDb) {
  console.error("REFUSING TO RUN: DATABASE_URL is not an isolated local test database.");
  process.exit(1);
}

// Must be set before the Prisma client is loaded.
process.env.DATABASE_URL = databaseUrl;
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl, max: 5 }),
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "ascii");
const pdfDataUri = () => `data:application/pdf;base64,${PDF.toString("base64")}`;
const corruptPdfDataUri = () =>
  `data:application/pdf;base64,${Buffer.from("this is definitely not a pdf").toString("base64")}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let counter = 0;

const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

const unique = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`.toUpperCase();

/* Patient emails are unique in the HMS database, so every run uses its own
   namespace to stay re-runnable against the same isolated database. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const mail = (label) => `e2e.${label}.${RUN}@example.com`;

const setMode = (mode) => fs.writeFileSync(modeFile, mode, "utf8");

const readMessages = () => {
  const file = path.join(outboxDir, "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const latestEml = (id) => fs.readFileSync(path.join(outboxDir, `${id}.eml`), "utf8");

const api = async (method, route, body) => {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
};

let token = "";
let child = null;
let smtp = null;

const waitForPort = async (port, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await sleep(500);
  }
  return false;
};

const waitFor = async (fn, timeoutMs = 25000, intervalMs = 300) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
};

const deliveryFor = (reportId) =>
  prisma.lab_report_email_delivery.findFirst({
    where: { lab_report_id: reportId },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });

const deliveryCountFor = (reportId) =>
  prisma.lab_report_email_delivery.count({ where: { lab_report_id: reportId } });

let branchId = "";
let adminUserId = "";
let adminEmployeeId = "";

const createPatient = async (email, label) => {
  const username = `e2e${label}${Date.now().toString(36)}${counter++}`.toLowerCase();
  const mobile = `+9199${String(Date.now()).slice(-6)}${String(counter).padStart(2, "0")}`;
  const response = await api("POST", "/api/patients/create", {
    username,
    password: "Test@12345",
    branch_id: branchId,
    first_name: "E2E",
    last_name: label,
    mobile,
    ...(email === undefined ? {} : { email }),
    patient_type: "Self",
    created_by: "E2E",
  });
  if (response.status !== 201 && email !== undefined) {
    console.log(
      `  [createPatient ${label}] unexpected ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
    );
  }
  return { response, mobile, username };
};

const makeReport = async ({ patientId, file = pdfDataUri() }) => {
  const historyId = unique("PH");
  await prisma.patient_history.create({
    data: { patient_history_id: historyId, patient_id: patientId, branch_id: branchId },
  });
  const orderId = unique("LO");
  await prisma.lab_order.create({
    data: {
      lab_order_id: orderId,
      doctor_employee_id: adminEmployeeId,
      patient_history_id: historyId,
      branch_id: branchId,
      order_status: "Ordered",
    },
  });
  const reportId = unique("RPT");
  await prisma.lab_report.create({
    data: {
      lab_report_id: reportId,
      lab_order_id: orderId,
      report_number: unique("E2E"),
      report_status: "Generated",
      report_file: file,
      generated_datetime: new Date(),
    },
  });
  return { reportId, orderId };
};

const approve = (orderId, file) =>
  api("POST", "/api/lab-report", {
    lab_order_id: orderId,
    report_status: "Generated",
    ...(file === undefined ? {} : { report_file: file }),
    overall_decision: "Approved",
    parameters: [],
    clinical_correlation: "E2E verification",
    report_comment: JSON.stringify({ text: "E2E approval", overallDecision: "Approved" }),
  });

const startBackend = () => {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PORT: String(API_PORT),
    MAIL_HOST: "127.0.0.1",
    MAIL_PORT: String(SMTP_PORT),
    MAIL_USER: "e2e@hms.test",
    MAIL_PASS: "e2e-password",
    MAIL_FROM: "labs@hms.test",
    JWT_SECRET: appEnv.JWT_SECRET,
  };
  delete env.WHATSAPP_ENABLED;

  const log = fs.openSync(backendLog, "w");
  child = spawn(
    process.execPath,
    [path.join(backendDir, "node_modules", "ts-node", "dist", "bin.js"), "src/server.ts"],
    { cwd: backendDir, env, stdio: ["ignore", log, log] },
  );
};

async function main() {
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.writeFileSync(path.join(outboxDir, "messages.jsonl"), "", "utf8");
  setMode("accept");

  branchId = (await prisma.branch.findFirst({ select: { branch_id: true } })).branch_id;

  const approvers = ["ADMIN", "HEAD_ADMIN", "SUPER_ADMIN", "BRANCH_ADMIN", "DOCTOR"];
  for (const role of approvers) {
    const users = await prisma.user_table.findMany({ where: { role_type: role }, take: 10 });
    for (const user of users) {
      const employee = await prisma.employees.findFirst({ where: { user_id: user.user_id } });
      if (employee) {
        adminUserId = user.user_id;
        adminEmployeeId = employee.employee_id;
        token = jwt.sign(
          { user_id: user.user_id, role, username: user.username },
          appEnv.JWT_SECRET,
          { expiresIn: "1h" },
        );
        break;
      }
    }
    if (token) break;
  }
  if (!token) throw new Error("No approver user with an employee record found in the test database.");

  smtp = await startFakeSmtp({ port: SMTP_PORT, modeFile, outboxDir });
  startBackend();
  if (!(await waitForPort(API_PORT))) throw new Error("Backend did not start. See " + backendLog);

  // ---------------------------------------------------------------- T19
  const whatsappProbe = await api("GET", "/api/lab-report/does-not-exist/whatsapp");
  const webhookProbe = await fetch(`${BASE}/api/lab-report/whatsapp/webhook`, { method: "POST" });
  check(
    "T19 WhatsApp endpoints disabled when WHATSAPP_ENABLED is off",
    whatsappProbe.status === 404 && webhookProbe.status === 404,
    `GET=${whatsappProbe.status} webhook=${webhookProbe.status}`,
  );

  // ---------------------------------------------------------------- T1
  const missing = await createPatient(undefined, "NoEmail");
  check(
    "T1 new patient without email is rejected",
    missing.response.status === 400 &&
      /email is required/i.test(String(missing.response.body?.message || "")),
    `${missing.response.status} ${missing.response.body?.message || ""}`,
  );

  // ---------------------------------------------------------------- T2
  const valid = await createPatient(`  ${mail("valid")}  `, "Valid");
  const createdPatientId = valid.response.body?.data?.patient?.patient_id;
  const stored = createdPatientId
    ? await prisma.patient_bio_data.findUnique({ where: { patient_id: createdPatientId } })
    : null;
  check(
    "T2 new patient with email succeeds and stores the trimmed address",
    valid.response.status === 201 && stored?.patient_email === mail("valid"),
    `${valid.response.status} stored=${stored?.patient_email}`,
  );

  // ---------------------------------------------------------------- T4
  const pendingReport = await makeReport({ patientId: createdPatientId });
  const pendingRecipient = await api("GET", `/api/lab-report/${pendingReport.reportId}/email`);
  const pendingDeliveries = await deliveryCountFor(pendingReport.reportId);
  check(
    "T4 unapproved report is not emailed",
    pendingRecipient.status === 200 &&
      pendingRecipient.body?.data?.status?.status === "PENDING" &&
      pendingDeliveries === 0 &&
      readMessages().length === 0,
    `status=${pendingRecipient.body?.data?.status?.status} rows=${pendingDeliveries}`,
  );

  // ---------------------------------------------------------------- T3
  await prisma.patient_bio_data.update({
    where: { patient_id: createdPatientId },
    data: { patient_email: null },
  });
  const legacyEdit = await api("PUT", `/api/patients/${createdPatientId}`, {
    first_name: "LegacyEdited",
    mobile: valid.mobile,
  });
  const legacyAfter = await prisma.patient_bio_data.findUnique({
    where: { patient_id: createdPatientId },
  });
  check(
    "T3 legacy patient without email remains editable",
    legacyEdit.status === 200 &&
      legacyAfter?.patient_first_name === "LegacyEdited" &&
      legacyAfter?.patient_email === null,
    `${legacyEdit.status} name=${legacyAfter?.patient_first_name} email=${legacyAfter?.patient_email}`,
  );

  // ---------------------------------------------------------------- T17
  const beforeMissingEmail = readMessages().length;
  const missingEmailApproval = await approve(pendingReport.orderId, pdfDataUri());
  const missingEmailDelivery = await waitFor(async () => {
    const row = await deliveryFor(pendingReport.reportId);
    return row && row.status === "FAILED" ? row : null;
  });
  check(
    "T17 missing patient email blocks sending and records a reason",
    missingEmailApproval.status === 201 &&
      missingEmailDelivery?.status === "FAILED" &&
      /no valid registered email/i.test(String(missingEmailDelivery?.error_message || "")) &&
      readMessages().length === beforeMissingEmail,
    `approval=${missingEmailApproval.status} status=${missingEmailDelivery?.status}`,
  );

  // ---------------------------------------------------------------- T5/T6/T7/T10
  const healthyPatient = await createPatient(mail("report"), "Report");
  const healthyPatientId = healthyPatient.response.body?.data?.patient?.patient_id;
  const healthyReport = await makeReport({ patientId: healthyPatientId });
  const beforeHealthy = readMessages().length;
  const approvalStarted = Date.now();
  const healthyApproval = await approve(healthyReport.orderId, pdfDataUri());
  const approvalDuration = Date.now() - approvalStarted;
  const sentDelivery = await waitFor(async () => {
    const row = await deliveryFor(healthyReport.reportId);
    return row && (row.status === "SENT" || row.status === "FAILED") ? row : null;
  });
  const healthyMessages = readMessages();
  const newMessage = healthyMessages[healthyMessages.length - 1];
  const eml = newMessage ? latestEml(newMessage.id) : "";
  check(
    "T5 approved report triggers automatic delivery",
    healthyApproval.status === 201 && sentDelivery?.status === "SENT",
    `approval=${healthyApproval.status} status=${sentDelivery?.status} took=${approvalDuration}ms`,
  );
  check(
    "T6 recipient is the patient's registered email",
    sentDelivery?.email_address === mail("report") &&
      newMessage?.recipients?.some((line) => line.includes(mail("report"))),
    `db=${sentDelivery?.email_address}`,
  );
  check(
    "T7 the actual report PDF is attached with a meaningful filename",
    eml.includes(`Lab_Report_${healthyReport.reportId}.pdf`) &&
      eml.includes(PDF.toString("base64").slice(0, 40)) &&
      eml.includes("Subject: Your Laboratory Test Report - HMS"),
    eml.includes(`Lab_Report_${healthyReport.reportId}.pdf`) ? "filename+pdf present" : "missing attachment",
  );
  check(
    "T10 SMTP acceptance results in SENT (not before)",
    sentDelivery?.status === "SENT" && Boolean(sentDelivery?.sent_at) && readMessages().length === beforeHealthy + 1,
    `status=${sentDelivery?.status}`,
  );

  // ---------------------------------------------------------------- T14
  const beforeReapprove = readMessages().length;
  const reapprove = await api("PUT", `/api/lab-report/${healthyReport.reportId}`, {
    overall_decision: "Approved",
    report_status: "Generated",
    report_file: pdfDataUri(),
  });
  await sleep(2500);
  const afterReapprove = await deliveryFor(healthyReport.reportId);
  check(
    "T14 a report already SENT is not sent again",
    reapprove.status === 200 &&
      (await deliveryCountFor(healthyReport.reportId)) === 1 &&
      afterReapprove?.status === "SENT" &&
      readMessages().length === beforeReapprove,
    `rows=${await deliveryCountFor(healthyReport.reportId)} outbox+${readMessages().length - beforeReapprove}`,
  );

  // ---------------------------------------------------------------- T8/T9
  const noPdfPatient = await createPatient(mail("nopdf"), "NoPdf");
  const noPdfReport = await makeReport({ patientId: noPdfPatient.response.body?.data?.patient?.patient_id, file: null });
  const noPdfApproval = await approve(noPdfReport.orderId, undefined);
  const noPdfDelivery = await waitFor(async () => {
    const row = await deliveryFor(noPdfReport.reportId);
    return row && row.status === "FAILED" ? row : null;
  });
  check(
    "T8 missing PDF is not sent and is recorded as failed",
    noPdfApproval.status === 201 && noPdfDelivery?.status === "FAILED" && /pdf.*unavailable/i.test(String(noPdfDelivery?.error_message || "")),
    `status=${noPdfDelivery?.status} reason=${noPdfDelivery?.error_message}`,
  );

  const corruptPatient = await createPatient(mail("corrupt"), "Corrupt");
  const corruptReport = await makeReport({ patientId: corruptPatient.response.body?.data?.patient?.patient_id });
  const corruptApproval = await approve(corruptReport.orderId, corruptPdfDataUri());
  const corruptDelivery = await waitFor(async () => {
    const row = await deliveryFor(corruptReport.reportId);
    return row && row.status === "FAILED" ? row : null;
  });
  check(
    "T9 corrupted PDF is rejected",
    corruptApproval.status === 201 && corruptDelivery?.status === "FAILED" && /not a valid PDF/i.test(String(corruptDelivery?.error_message || "")),
    `status=${corruptDelivery?.status} reason=${corruptDelivery?.error_message}`,
  );

  // ---------------------------------------------------------------- T18
  const optOutPatient = await createPatient(mail("optout"), "OptOut");
  const optOutId = optOutPatient.response.body?.data?.patient?.patient_id;
  await prisma.patient_email_consent.create({
    data: {
      patient_id: optOutId,
      email_address: mail("optout"),
      consented: false,
      consented_by: "E2E",
    },
  });
  const optOutReport = await makeReport({ patientId: optOutId });
  const beforeOptOut = readMessages().length;
  const optOutApproval = await approve(optOutReport.orderId, pdfDataUri());
  const optOutDelivery = await waitFor(async () => {
    const row = await deliveryFor(optOutReport.reportId);
    return row && row.status === "FAILED" ? row : null;
  });
  check(
    "T18 recorded consent opt-out blocks automatic sending",
    optOutApproval.status === 201 &&
      optOutDelivery?.status === "FAILED" &&
      /opted out/i.test(String(optOutDelivery?.error_message || "")) &&
      readMessages().length === beforeOptOut,
    `status=${optOutDelivery?.status} reason=${optOutDelivery?.error_message}`,
  );
  check(
    "T18 approval never creates a patient consent record",
    (await prisma.patient_email_consent.count({ where: { patient_id: optOutId } })) === 1,
    `consent rows=${await prisma.patient_email_consent.count({ where: { patient_id: optOutId } })}`,
  );

  // ---------------------------------------------------------------- T11/T13
  setMode("reject-recipient");
  const rejectPatient = await createPatient(mail("reject"), "Reject");
  const rejectReport = await makeReport({ patientId: rejectPatient.response.body?.data?.patient?.patient_id });
  const rejectApproval = await approve(rejectReport.orderId, pdfDataUri());
  const rejectDelivery = await waitFor(async () => {
    const row = await deliveryFor(rejectReport.reportId);
    return row && (row.status === "FAILED" || row.status === "UNKNOWN") ? row : null;
  });
  check(
    "T11 SMTP recipient rejection results in FAILED",
    rejectApproval.status === 201 && rejectDelivery?.status === "FAILED",
    `status=${rejectDelivery?.status} reason=${String(rejectDelivery?.error_message).slice(0, 80)}`,
  );

  setMode("accept");
  const beforeRetry = readMessages().length;
  const retry = await api("POST", `/api/lab-report/${rejectReport.reportId}/email`, { consentConfirmed: true });
  const retried = await waitFor(async () => {
    const row = await deliveryFor(rejectReport.reportId);
    return row && row.status === "SENT" ? row : null;
  });
  check(
    "T13 retry after a recoverable failure succeeds",
    retry.status === 200 && retried?.status === "SENT" && readMessages().length === beforeRetry + 1,
    `retry=${retry.status} status=${retried?.status}`,
  );

  // ---------------------------------------------------------------- T15
  setMode("reject-recipient");
  const concurrentPatient = await createPatient(mail("concurrent"), "Concurrent");
  const concurrentReport = await makeReport({ patientId: concurrentPatient.response.body?.data?.patient?.patient_id });
  await approve(concurrentReport.orderId, pdfDataUri());
  await waitFor(async () => {
    const row = await deliveryFor(concurrentReport.reportId);
    return row && row.status === "FAILED" ? row : null;
  });
  setMode("accept");
  const beforeConcurrent = readMessages().length;
  const [first, second] = await Promise.all([
    api("POST", `/api/lab-report/${concurrentReport.reportId}/email`, { consentConfirmed: true }),
    api("POST", `/api/lab-report/${concurrentReport.reportId}/email`, { consentConfirmed: true }),
  ]);
  await sleep(2500);
  const concurrentRows = await prisma.lab_report_email_delivery.findMany({
    where: { lab_report_id: concurrentReport.reportId },
  });
  check(
    "T15 simultaneous retries cannot create duplicate deliveries",
    [first.status, second.status].filter((status) => status === 200).length === 1 &&
      concurrentRows.filter((row) => row.status === "SENT").length === 1 &&
      readMessages().length === beforeConcurrent + 1,
    `http=${first.status}/${second.status} sentRows=${concurrentRows.filter((row) => row.status === "SENT").length}`,
  );

  // ---------------------------------------------------------------- T12
  await smtp.close();
  smtp = null;
  const downPatient = await createPatient(mail("smtpdown"), "SmtpDown");
  const downReport = await makeReport({ patientId: downPatient.response.body?.data?.patient?.patient_id });
  const downApproval = await approve(downReport.orderId, pdfDataUri());
  const downDelivery = await waitFor(async () => {
    const row = await deliveryFor(downReport.reportId);
    return row && (row.status === "FAILED" || row.status === "UNKNOWN") ? row : null;
  });
  check(
    "T12 SMTP unavailable before transmission results in FAILED (retryable)",
    downApproval.status === 201 && downDelivery?.status === "FAILED",
    `status=${downDelivery?.status} reason=${String(downDelivery?.error_message).slice(0, 80)}`,
  );

  setMode("accept");
  smtp = await startFakeSmtp({ port: SMTP_PORT, modeFile, outboxDir });
  const beforeDownRetry = readMessages().length;
  const downRetry = await api("POST", `/api/lab-report/${downReport.reportId}/email`, { consentConfirmed: true });
  const downRetried = await waitFor(async () => {
    const row = await deliveryFor(downReport.reportId);
    return row && row.status === "SENT" ? row : null;
  });
  check(
    "T12b retry succeeds once SMTP is reachable again",
    downRetry.status === 200 && downRetried?.status === "SENT" && readMessages().length === beforeDownRetry + 1,
    `retry=${downRetry.status} status=${downRetried?.status}`,
  );

  // ---------------------------------------------------------------- T16
  const unknownPatient = await createPatient(mail("unknown"), "Unknown");
  const unknownReport = await makeReport({ patientId: unknownPatient.response.body?.data?.patient?.patient_id });
  await prisma.lab_report_email_delivery.create({
    data: {
      id: require("crypto").randomUUID(),
      patient_id: unknownPatient.response.body?.data?.patient?.patient_id,
      lab_report_id: unknownReport.reportId,
      email_address: mail("unknown"),
      status: "UNKNOWN",
      error_message: "Simulated unknown outcome from a previous attempt.",
      created_by: "E2E",
      updated_at: new Date(),
    },
  });
  const beforeUnknown = readMessages().length;
  // Approving the report must not auto-resend while an UNKNOWN row exists.
  const unknownApproval = await api("PUT", `/api/lab-report/${unknownReport.reportId}`, {
    approved_by: adminEmployeeId,
    report_status: "Generated",
    report_file: pdfDataUri(),
    overall_decision: "Approved",
  });
  await sleep(2000);
  // A manual retry is also blocked: the true outcome is unknown.
  const unknownRetry = await api("POST", `/api/lab-report/${unknownReport.reportId}/email`, { consentConfirmed: true });
  const unknownDelivery = await deliveryFor(unknownReport.reportId);
  check(
    "T16 UNKNOWN delivery is never resent automatically",
    unknownApproval.status === 200 &&
      unknownRetry.status === 400 &&
      /unknown/i.test(String(unknownRetry.body?.message || "")) &&
      unknownDelivery?.status === "UNKNOWN" &&
      readMessages().length === beforeUnknown &&
      (await deliveryCountFor(unknownReport.reportId)) === 1,
    `approval=${unknownApproval.status} retry=${unknownRetry.status} rows=${await deliveryCountFor(unknownReport.reportId)} reason=${String(unknownRetry.body?.message || "").slice(0, 90)}`,
  );

  // ---------------------------------------------------------------- T21
  const stalePatient = await createPatient(mail("stale"), "Stale");
  const stalePatientId = stalePatient.response.body?.data?.patient?.patient_id;
  const staleReport = await makeReport({ patientId: stalePatientId });
  await prisma.lab_report.update({
    where: { lab_report_id: staleReport.reportId },
    data: { approved_by: adminEmployeeId, approved_datetime: new Date() },
  });
  const staleAt = new Date(Date.now() - 20 * 60 * 1000);
  const staleRow = await prisma.lab_report_email_delivery.create({
    data: {
      id: require("crypto").randomUUID(),
      patient_id: stalePatientId,
      lab_report_id: staleReport.reportId,
      email_address: mail("stale"),
      status: "PROCESSING",
      created_by: "E2E",
      created_at: staleAt,
      updated_at: staleAt,
    },
  });
  const staleRecipient = await api("GET", `/api/lab-report/${staleReport.reportId}/email`);
  const staleAfter = await prisma.lab_report_email_delivery.findUnique({ where: { id: staleRow.id } });
  setMode("accept");
  const beforeStale = readMessages().length;
  const staleRetry = await api("POST", `/api/lab-report/${staleReport.reportId}/email`, { consentConfirmed: true });
  const staleSent = await waitFor(async () => {
    const row = await deliveryFor(staleReport.reportId);
    return row && row.status === "SENT" ? row : null;
  });
  check(
    "T21 stale PROCESSING is recovered as FAILED and can be retried",
    staleRecipient.status === 200 &&
      staleRecipient.body?.data?.status?.status === "FAILED" &&
      staleAfter?.status === "FAILED" &&
      staleRetry.status === 200 &&
      staleSent?.status === "SENT" &&
      readMessages().length === beforeStale + 1,
    `status=${staleRecipient.body?.data?.status?.status} retry=${staleRetry.status} sent=${staleSent?.status}`,
  );

  // ---------------------------------------------------------------- T22
  setMode("drop-on-data");
  const droppedPatient = await createPatient(mail("dropped"), "Dropped");
  const droppedReport = await makeReport({ patientId: droppedPatient.response.body?.data?.patient?.patient_id });
  const beforeDropped = readMessages().length;
  const droppedApproval = await approve(droppedReport.orderId, pdfDataUri());
  const droppedDelivery = await waitFor(
    async () => {
      const row = await deliveryFor(droppedReport.reportId);
      return row && ["SENT", "FAILED", "UNKNOWN"].includes(row.status) ? row : null;
    },
    40000,
  );
  setMode("accept");
  const droppedRetry = await api("POST", `/api/lab-report/${droppedReport.reportId}/email`, { consentConfirmed: true });
  check(
    "T22 connection lost during message transmission is UNKNOWN and never auto-resent",
    droppedApproval.status === 201 &&
      droppedDelivery?.status === "UNKNOWN" &&
      droppedRetry.status === 400 &&
      /unknown/i.test(String(droppedRetry.body?.message || "")) &&
      readMessages().length === beforeDropped &&
      (await deliveryCountFor(droppedReport.reportId)) === 1,
    `status=${droppedDelivery?.status} retry=${droppedRetry.status} reason=${String(droppedDelivery?.error_message || "").slice(0, 80)}`,
  );

  // ---------------------------------------------------------------- T20
  const listReports = await api("GET", "/api/lab-report");
  const unauth = await fetch(`${BASE}/api/lab-report`);
  const patients = await api("GET", "/api/patients?page=1&limit=1");
  check(
    "T20 existing authenticated modules still work and auth is still enforced",
    listReports.status === 200 && unauth.status === 401 && (patients.status === 200 || patients.status === 403),
    `reports=${listReports.status} unauth=${unauth.status} patients=${patients.status}`,
  );
}

(async () => {
  let failure = null;
  try {
    await main();
  } catch (error) {
    failure = error;
    console.error("HARNESS ERROR:", error instanceof Error ? error.stack : error);
  } finally {
    if (child) child.kill();
    if (smtp) await smtp.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  if (failure) {
    console.log("Backend log:", backendLog);
    process.exit(1);
  }
  process.exit(failed.length === 0 ? 0 : 1);
})();
