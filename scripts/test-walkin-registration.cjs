const fs = require("node:fs");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const config = dotenv.parse(fs.readFileSync(".env.test.local"));
const databaseUrl = new URL(config.DATABASE_URL || "");
if (
  databaseUrl.hostname !== "127.0.0.1" ||
  databaseUrl.port !== "55432" ||
  databaseUrl.pathname !== "/hms_new_lab_walkin_test"
) {
  throw new Error("Refusing API tests: DATABASE_URL is not the isolated local walk-in test database.");
}

const API = "http://127.0.0.1:5011/api";
const branchId = "TESTBRANCH0001";
const userId = "TESTLABUSER0001";
const employeeId = "TESTLABEMP0001";
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: 2 }),
});
const token = jwt.sign(
  {
    user_id: userId,
    username: "synthetic_lab_staff",
    role: "LAB_TECHNICIAN",
    employee_id: employeeId,
  },
  config.JWT_SECRET,
  { expiresIn: "10m" },
);
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-branch-id": branchId,
};

async function request(path, { method = "GET", body, expectedStatus = 200 } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status}: ${result.message || JSON.stringify(result)}`);
  }
  return result;
}

async function uniquePhone(email) {
  const candidates = Array.from({ length: 100 }, (_, index) => index)
    .sort(() => Math.random() - 0.5);
  for (const suffix of candidates) {
    const mobile = `+1 202-555-01${String(suffix).padStart(2, "0")}`;
    const result = await request(`/patients/check-duplicates?branchId=${branchId}`, {
      method: "POST",
      body: { mobile, email },
    });
    if (result.data.matches.length === 0) return mobile;
  }
  throw new Error("No unused synthetic 202-555-01xx test number was available.");
}

async function createSyntheticPatient(label) {
  const email = `walkin-${crypto.randomUUID()}@example.com`;
  const mobile = await uniquePhone(email);
  const duplicateCheck = await request(`/patients/check-duplicates?branchId=${branchId}`, {
    method: "POST",
    body: { mobile, email },
  });
  if (duplicateCheck.data.matches.length !== 0) {
    throw new Error("A generated synthetic contact unexpectedly matched an existing record.");
  }

  const response = await request("/patients/create", {
    method: "POST",
    expectedStatus: 201,
    body: {
      username: `synthetic_walkin_${crypto.randomUUID()}`,
      password: crypto.randomUUID(),
      first_name: "Synthetic",
      last_name: `Walkin${label}`,
      mobile,
      email,
      branch_id: branchId,
      created_by: "LAB_TECHNICIAN",
    },
  });
  const patient = response.data.patient;
  if (!patient?.patient_id) throw new Error("Patient API did not return the generated patient ID.");
  return { patient, mobile, email };
}

async function main() {
  const [identity] = await prisma.$queryRaw`
    SELECT current_database() AS database,
           inet_server_addr()::text AS address,
           inet_server_port() AS port,
           (SELECT COUNT(*)::int FROM user_table WHERE user_id = ${userId}) AS fixture_users
  `;
  if (
    identity.database !== "hms_new_lab_walkin_test" ||
    !identity.address.startsWith("127.0.0.1") ||
    Number(identity.port) !== 55432 ||
    identity.fixture_users !== 1
  ) {
    throw new Error("API test preflight failed: isolated database or synthetic Lab Staff account was not verified.");
  }
  console.log("Verified API target: http://127.0.0.1:5011/api");
  console.log("Verified database: postgresql://127.0.0.1:55432/hms_new_lab_walkin_test");

  const [first, second] = await Promise.all([
    createSyntheticPatient("A"),
    createSyntheticPatient("B"),
  ]);
  if (first.patient.patient_id === second.patient.patient_id) {
    throw new Error("Two unique patient registrations returned the same patient ID.");
  }
  console.log("PASS: two new patients with unique mobile/email were saved.");

  const checkMatches = async (mobile, email) => {
    const result = await request(`/patients/check-duplicates?branchId=${branchId}`, {
      method: "POST",
      body: { mobile, email },
    });
    return result.data.matches;
  };
  const mobileMatch = await checkMatches(first.mobile, `new-${crypto.randomUUID()}@example.com`);
  if (mobileMatch.length !== 1 || mobileMatch[0].patient_id !== first.patient.patient_id || !mobileMatch[0].matched_by_mobile || mobileMatch[0].matched_by_email) {
    throw new Error("Existing primary mobile + new email did not identify exactly the matching patient.");
  }
  const emailMatch = await checkMatches(await uniquePhone(`email-match-${crypto.randomUUID()}@example.com`), first.email);
  if (emailMatch.length !== 1 || emailMatch[0].patient_id !== first.patient.patient_id || emailMatch[0].matched_by_mobile || !emailMatch[0].matched_by_email) {
    throw new Error("New mobile + existing email did not identify exactly the matching patient.");
  }
  const samePatientMatch = await checkMatches(first.mobile, first.email);
  if (samePatientMatch.length !== 1 || samePatientMatch[0].patient_id !== first.patient.patient_id || !samePatientMatch[0].matched_by_mobile || !samePatientMatch[0].matched_by_email) {
    throw new Error("Existing mobile and email did not resolve to the same patient.");
  }
  const conflictingMatches = await checkMatches(first.mobile, second.email);
  if (
    conflictingMatches.length !== 2 ||
    !conflictingMatches.some((match) => match.patient_id === first.patient.patient_id && match.matched_by_mobile && !match.matched_by_email) ||
    !conflictingMatches.some((match) => match.patient_id === second.patient.patient_id && !match.matched_by_mobile && match.matched_by_email)
  ) {
    throw new Error("Conflicting mobile/email contacts did not return both distinct patient matches.");
  }
  console.log("PASS: mobile, email, combined, and conflicting duplicate checks.");

  const beforeRejectedDuplicates = await prisma.patient_bio_data.count();
  const rejectedMobile = await request("/patients/create", {
    method: "POST",
    expectedStatus: 400,
    body: {
      username: `synthetic_duplicate_${crypto.randomUUID()}`,
      password: crypto.randomUUID(),
      first_name: "Synthetic",
      last_name: "Duplicate",
      mobile: first.mobile,
      email: `new-${crypto.randomUUID()}@example.com`,
      branch_id: branchId,
      created_by: "LAB_TECHNICIAN",
    },
  });
  if (!rejectedMobile.message.includes("Mobile already exists")) {
    throw new Error("Server-side duplicate mobile check did not reject the write.");
  }
  const rejectedEmail = await request("/patients/create", {
    method: "POST",
    expectedStatus: 400,
    body: {
      username: `synthetic_duplicate_${crypto.randomUUID()}`,
      password: crypto.randomUUID(),
      first_name: "Synthetic",
      last_name: "Duplicate",
      mobile: await uniquePhone(`new-${crypto.randomUUID()}@example.com`),
      email: first.email,
      branch_id: branchId,
      created_by: "LAB_TECHNICIAN",
    },
  });
  if (!rejectedEmail.message.includes("Email already exists") || await prisma.patient_bio_data.count() !== beforeRejectedDuplicates) {
    throw new Error("Server-side duplicate email check failed or a duplicate patient was written.");
  }
  console.log("PASS: server rejected duplicate contact writes without creating duplicate patient records.");

  const testsResponse = await request("/lab-test-master");
  const tests = testsResponse.data.filter((test) => test.test_code.startsWith("SYN-WALKIN-"));
  if (tests.length !== 4) throw new Error(`Expected four synthetic Lab Master tests; found ${tests.length}.`);

  const historicalLongOrder = await prisma.lab_order.findFirst({
    where: { branch_id: branchId, lab_order_id: { startsWith: "LAB" } },
    orderBy: { created_at: "asc" },
    select: { lab_order_id: true },
  });
  const historicalLongOrderId = historicalLongOrder &&
    !/^LAB\d{13}$/.test(historicalLongOrder.lab_order_id)
    ? historicalLongOrder.lab_order_id
    : null;

  const createOrder = async () => {
    const response = await request("/lab-order", {
      method: "POST",
      expectedStatus: 201,
      body: {
        patient_id: first.patient.patient_id,
        doctor_employee_id: employeeId,
        branch_id: branchId,
        user_id: userId,
        priority: "Normal",
        clinical_notes: "Synthetic walk-in registration test",
      },
    });
    if (!response.data?.lab_order_id) throw new Error("Lab-order API did not return an order ID.");
    return response.data.lab_order_id;
  };
  const firstOrderId = await createOrder();
  const concurrentOrderIds = await Promise.all(
    Array.from({ length: 11 }, () => createOrder()),
  );
  const orderIds = [firstOrderId, ...concurrentOrderIds];
  if (orderIds.some((id) => !/^LAB\d{13}$/.test(id))) {
    throw new Error(`New lab order IDs must use LAB plus 13 digits: ${orderIds.join(", ")}`);
  }
  if (new Set(orderIds).size !== orderIds.length) {
    throw new Error("Concurrent lab-order creation returned duplicate IDs.");
  }
  const secondOrderId = concurrentOrderIds[0];
  console.log("PASS: 12 new orders use unique LAB + 13-digit IDs, including concurrent creates.");

  const firstItemResponses = await Promise.all(tests.map((test) =>
    request("/lab-order-item", {
      method: "POST",
      expectedStatus: 201,
      body: {
        lab_order_id: firstOrderId,
        lab_test_id: test.lab_test_id,
        quantity: 1,
        priority: "Normal",
        branch_id: branchId,
        user_id: userId,
      },
    }),
  ));
  const secondOrderItem = await request("/lab-order-item", {
    method: "POST",
    expectedStatus: 201,
    body: {
      lab_order_id: secondOrderId,
      lab_test_id: tests[0].lab_test_id,
      quantity: 1,
      priority: "Normal",
      branch_id: branchId,
      user_id: userId,
    },
  });
  if (new Set(firstItemResponses.map((response) => response.data.lab_order_item_id)).size !== 4) {
    throw new Error("Four concurrent test items did not receive unique IDs.");
  }

  const dashboard = await request(`/lab-order?patientId=${first.patient.patient_id}`);
  const patientOrders = dashboard.data.filter((order) => order.patient_history?.patient_id === first.patient.patient_id);
  if (
    patientOrders.length !== orderIds.length ||
    orderIds.some((id) => !patientOrders.some((order) => order.lab_order_id === id))
  ) {
    throw new Error("Patient dashboard query did not return every newly created patient order.");
  }

  const tracking = await request(`/lab-order/${firstOrderId}`);
  if (
    tracking.data?.patient_history?.patient_id !== first.patient.patient_id ||
    tracking.data?.lab_order_item?.length !== 4
  ) {
    throw new Error("Order-specific tracking response did not contain the correct patient and all four tests.");
  }
  const patientItems = await request(`/lab-order-item?patientId=${first.patient.patient_id}`);
  const linkedItems = patientItems.data.filter((item) => item.lab_order_id === firstOrderId);
  if (linkedItems.length !== 4 || linkedItems.some((item) => item.lab_order_id !== firstOrderId)) {
    throw new Error("Patient-specific test-item retrieval did not return all four items for the requested order.");
  }
  const secondTracking = await request(`/lab-order/${secondOrderId}`);
  if (secondTracking.data?.patient_history?.patient_id !== first.patient.patient_id || secondTracking.data?.lab_order_item?.length !== 1) {
    throw new Error("Second order tracking did not remain separate for the same patient.");
  }
  if (historicalLongOrderId) {
    const historicalTracking = await request(`/lab-order/${encodeURIComponent(historicalLongOrderId)}`);
    if (historicalTracking.data?.lab_order_id !== historicalLongOrderId) {
      throw new Error("A historical long-format lab order ID no longer resolves.");
    }
    console.log("PASS: existing long-format lab order IDs still resolve.");
  } else {
    console.log("SKIP: no historical long-format lab order was available to verify.");
  }
  console.log(`PASS: ${orderIds.length} distinct orders and five test items persisted for one synthetic patient.`);
  console.log("PASS: dashboard and order-specific tracking returned the correct patient/order/item links.");
  console.log(JSON.stringify({
    syntheticPatientIds: [first.patient.patient_id, second.patient.patient_id],
    orderIds,
    firstOrderItemCount: linkedItems.length,
    secondOrderItemCount: 1,
  }));
}

main()
  .catch((error) => {
    console.error(`Walk-in API integration test failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
