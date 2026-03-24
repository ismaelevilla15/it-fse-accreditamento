#!/usr/bin/env node

/**
 * FSE CDA validator - single file script
 *
 * Cosa fa:
 * 1) legge auth.p12 e sign.p12
 * 2) estrae private key + cert da sign.p12
 * 3) genera JWT Authorization e FSE-JWT-Signature
 * 4) verifica localmente alcune cose sul CDA XML
 * 5) se presente il PDF, chiama /v1/documents/validation
 *
 * Uso:
 *   node fse_validate.js
 *
 * Configura i valori nel blocco CONFIG qui sotto.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const axios = require("axios");
const FormData = require("form-data");
const forge = require("node-forge");
const jwt = require("jsonwebtoken");
const { XMLParser } = require("fast-xml-parser");

/* =========================================================
 * CONFIG - MODIFICA QUI
 * ========================================================= */
const CONFIG = {
  // Endpoint GTW pre-prod o ambiente regionale/middleware
  validationUrl: "https://modipa-val.fse.salute.gov.it/govway/rest/in/FSE/gateway/v1/documents/validation",
  // Certificati P12
  authP12Path: "./keys/auth.p12",
  authP12Password: "medithynk",
  signP12Path: "./keys/sign.p12",
  signP12Password: "medithynk",

  // Documenti
  xmlPath: "RSA.xml",
  pdfPath: "./RSA_TESTCASE_1.pdf",

  // Header requestBody del gateway
  activity: "VALIDATION", // o VALIDATION
  healthDataFormat: "CDA",
  mode: "ATTACHMENT",

  // Claims JWT - DA PERSONALIZZARE
  purpose_of_use: "TREATMENT",
  resource_hl7_type: "('11488-4^^2.16.840.1.113883.6.1')",

  patient_consent: true,
  action_id: "CREATE",
  subject_role: "AAS",
  subject_organization: "Regione Lombardia",
  subject_organization_id: "030", // o quello corretto
  locality: "MEDITHYNK SRL^^^^^&2.16.840.1.113883.2.9.4.1.3&ISO^^^^111",
  subject_application_vendor: "Medithynk",
  subject_application_id: "clinical-app",
  subject_application_version: "1.0.0",

  // sub del JWT: tipicamente identificativo software/ente/utente tecnico
  person_id: "RSSMRA22A01A399Z^^^&2.16.840.1.113883.2.9.4.3.2&ISO",
  sub: "RSSMRA22A01A399Z^^^&2.16.840.1.113883.2.9.4.3.2&ISO",
  patient_consent: true,

  // audience / issuer style
  aud: "https://modipa-val.fse.salute.gov.it/govway/rest/in/FSE/gateway/v1",

  // Se true accetta cert server non validi. SOLO test.
  insecureSkipServerVerify: true,

  dataJsonPath: "./data.json",
  testCaseId: 1, // lo cambi tu a ogni run
  appendResultToDataJson: true,
};

/* =========================================================
 * UTILS
 * ========================================================= */

function fileExists(p) {
  return !!p && fs.existsSync(p);
}

function readFileUtf8(p) {
  return fs.readFileSync(p, "utf8");
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function formatIsoTimestampWith7Digits(date = new Date()) {
  const iso = date.toISOString(); // es: 2025-08-26T09:57:05.009Z
  const [base, msPart] = iso.split(".");
  const ms = (msPart || "000Z").replace("Z", ""); // "009"
  const padded = ms.padEnd(7, "0"); // "0090000"
  return `${base}.${padded}Z`;
}

function loadDataJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      appVendor: CONFIG.subject_application_vendor,
      appID: CONFIG.subject_application_id,
      appVersion: CONFIG.subject_application_version,
      results: [],
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.results)) {
    parsed.results = [];
  }

  if (!parsed.appVendor) parsed.appVendor = CONFIG.subject_application_vendor;
  if (!parsed.appID) parsed.appID = CONFIG.subject_application_id;
  if (!parsed.appVersion) parsed.appVersion = CONFIG.subject_application_version;

  return parsed;
}

function saveDataJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function extractTraceId(remoteResult) {
  return (
    remoteResult?.data?.traceId ||
    remoteResult?.data?.traceID ||
    remoteResult?.headers?.traceid ||
    remoteResult?.headers?.["traceid"] ||
    remoteResult?.headers?.["x-b3-traceid"] ||
    remoteResult?.headers?.["govway-traceid"] ||
    null
  );
}

function extractWorkflowInstanceId(remoteResult) {
  return (
    remoteResult?.data?.workflowInstanceId ||
    remoteResult?.data?.workflowinstanceid ||
    null
  );
}

function extractErrorMessageForUser(remoteResult) {
  const title = remoteResult?.data?.title || null;
  const detail = remoteResult?.data?.detail || null;

  if (title && detail) return `${title} - ${detail}`;
  if (title) return title;
  if (detail) return detail;
  return null;
}

function buildResultEntry(remoteResult) {
  const entry = {
    id: CONFIG.testCaseId,
    ts: formatIsoTimestampWith7Digits(),
    traceId: extractTraceId(remoteResult),
    files: [path.basename(CONFIG.pdfPath)],
  };

  const workflowInstanceId = extractWorkflowInstanceId(remoteResult);
  if (workflowInstanceId) {
    entry.workflowInstanceId = workflowInstanceId;
  }

  // campi extra comodi per uso interno / excel
  entry.httpStatus = remoteResult?.status ?? null;

  const errorTitle = remoteResult?.data?.title || null;
  const errorDetail = remoteResult?.data?.detail || null;
  const userMessage = extractErrorMessageForUser(remoteResult);

  if (errorTitle) entry.errorTitle = errorTitle;
  if (errorDetail) entry.errorDetail = errorDetail;
  if (userMessage) entry.userMessage = userMessage;

  return entry;
}

function appendResultToDataJson(remoteResult) {
  const data = loadDataJson(CONFIG.dataJsonPath);
  const entry = buildResultEntry(remoteResult);
  data.results.push(entry);
  saveDataJson(CONFIG.dataJsonPath, data);
  return entry;
}

function getFirst(arrOrObj) {
  return Array.isArray(arrOrObj) ? arrOrObj[0] : arrOrObj;
}

/* =========================================================
 * P12 PARSING
 * ========================================================= */

function extractKeyAndCertFromP12(p12Path, password) {
  const p12Buffer = fs.readFileSync(p12Path);
  const p12Der = forge.util.createBuffer(p12Buffer.toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  let privateKeyPem = null;
  let certificatePem = null;
  let certificateObj = null;

  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] || [];

  if (keyBags.length > 0) {
    const privateKey = keyBags[0].key;
    privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  }

  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];

  if (certBags.length > 0) {
    certificateObj = certBags[0].cert;
    certificatePem = forge.pki.certificateToPem(certificateObj);
  }

  if (!privateKeyPem || !certificatePem) {
    throw new Error(`Impossibile estrarre chiave/certificato da ${p12Path}`);
  }

  return {
    privateKeyPem,
    certificatePem,
    certificateObj,
  };
}

function getCertificateCommonName(certObj) {
  const subjectAttrs = certObj.subject.attributes || [];
  const cn = subjectAttrs.find(
    (a) => a.shortName === "CN" || a.name === "commonName"
  );
  return cn ? cn.value : null;
}

function getCertificateSerialNumber(certObj) {
  return certObj.serialNumber || null;
}

function getCertificateValidity(certObj) {
  return {
    notBefore: certObj.validity.notBefore,
    notAfter: certObj.validity.notAfter,
  };
}

/* =========================================================
 * XML / CDA CHECKS
 * ========================================================= */

function parseXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  return parser.parse(xmlString);
}

function extractCdaInfo(xmlString) {
  const parsed = parseXml(xmlString);

  const cd = parsed.ClinicalDocument;
  if (!cd) {
    throw new Error("XML non valido come CDA: nodo ClinicalDocument non trovato");
  }

  const code = cd.code || {};
  const codeSystem = code["@_codeSystem"] || null;
  const codeValue = code["@_code"] || null;
  const displayName = code["@_displayName"] || null;

  const realmCode = cd.realmCode || null;
  const templateId = cd.templateId || null;
  const id = cd.id || null;
  const effectiveTime = cd.effectiveTime || null;
  const recordTarget = cd.recordTarget || null;
  const author = cd.author || null;
  const custodian = cd.custodian || null;
  const component = cd.component || null;

  return {
    codeSystem,
    codeValue,
    displayName,
    hasRealmCode: !!realmCode,
    hasTemplateId: !!templateId,
    hasId: !!id,
    hasEffectiveTime: !!effectiveTime,
    hasRecordTarget: !!recordTarget,
    hasAuthor: !!author,
    hasCustodian: !!custodian,
    hasComponent: !!component,
  };
}

function localValidateXml(xmlPath) {
  const xml = readFileUtf8(xmlPath);

  const result = {
    ok: true,
    checks: [],
    cdaInfo: null,
    sha256: sha256File(xmlPath),
  };

  try {
    const cdaInfo = extractCdaInfo(xml);
    result.cdaInfo = cdaInfo;

    const checks = [
      ["ClinicalDocument/code presente", !!cdaInfo.codeValue],
      ["ClinicalDocument/codeSystem presente", !!cdaInfo.codeSystem],
      ["templateId presente", cdaInfo.hasTemplateId],
      ["id presente", cdaInfo.hasId],
      ["effectiveTime presente", cdaInfo.hasEffectiveTime],
      ["recordTarget presente", cdaInfo.hasRecordTarget],
      ["author presente", cdaInfo.hasAuthor],
      ["custodian presente", cdaInfo.hasCustodian],
      ["component presente", cdaInfo.hasComponent],
    ];

    for (const [name, ok] of checks) {
      result.checks.push({ name, ok });
      if (!ok) result.ok = false;
    }

    // coerenza base con resource_hl7_type
    if (CONFIG.resource_hl7_type && cdaInfo.displayName) {
        const hl7TypeFromXml = `${cdaInfo.codeValue}^^${cdaInfo.codeSystem}`;

        result.checks.push({
        name: "Coerenza resource_hl7_type/code+codeSystem",
        ok: CONFIG.resource_hl7_type === hl7TypeFromXml,
        expected: CONFIG.resource_hl7_type,
        actual: hl7TypeFromXml,
        });
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }

  return result;
}

/* =========================================================
 * JWT
 * ========================================================= */

function buildJwtPayload(kind, signCertCn) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 300; // 5 minuti

  const issPrefix = kind === "auth" ? "auth" : "integrity";

  return {
    iss: `${issPrefix}:${signCertCn}`,
    sub: CONFIG.sub,
    aud: CONFIG.aud,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp,

    // claims applicativi
    purpose_of_use: CONFIG.purpose_of_use,
    resource_hl7_type: CONFIG.resource_hl7_type,
    subject_role: CONFIG.subject_role,
    person_id: CONFIG.person_id,
    subject_organization: CONFIG.subject_organization,
    subject_organization_id: CONFIG.subject_organization_id,
    locality: CONFIG.locality,
    subject_application_vendor: CONFIG.subject_application_vendor,
    subject_application_id: CONFIG.subject_application_id,
    subject_application_version: CONFIG.subject_application_version,
    patient_consent: CONFIG.patient_consent,
    action_id: CONFIG.action_id,
  };
}

function generateJwt(privateKeyPem, payload, certificatePem) {
  const cleanCert = certificatePem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\r?\n|\r/g, "");

  return jwt.sign(payload, privateKeyPem, {
    algorithm: "RS256",
    header: {
      alg: "RS256",
      typ: "JWT",
      x5c: [cleanCert],
    },
  });
}

/* =========================================================
 * REMOTE VALIDATION
 * ========================================================= */

async function callValidationEndpoint(authP12Buffer, authP12Password, authJwt, signJwt) {
  const form = new FormData();

  const requestBody = {
    activity: CONFIG.activity,
    healthDataFormat: CONFIG.healthDataFormat,
    mode: CONFIG.mode,
  };

  form.append("requestBody", JSON.stringify(requestBody), {
    contentType: "application/json",
  });

  form.append("file", fs.createReadStream(CONFIG.pdfPath), {
    filename: path.basename(CONFIG.pdfPath),
    contentType: "application/pdf",
  });

  const httpsAgent = new https.Agent({
    pfx: authP12Buffer,
    passphrase: authP12Password,
    rejectUnauthorized: !CONFIG.insecureSkipServerVerify,
  });

  const headers = {
    ...form.getHeaders(),
    Accept: "application/json",
    Authorization: `Bearer ${authJwt}`,
    "FSE-JWT-Signature": signJwt,
  };

  try {
    const response = await axios.post(CONFIG.validationUrl, form, {
      headers,
      httpsAgent,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    return {
      status: response.status,
      headers: response.headers,
      data: response.data,
    };
  } catch (err) {
    return {
      status: err.response?.status || null,
      headers: err.response?.headers || {},
      data: err.response?.data || {
        title: "Errore tecnico",
        detail: err.message,
      },
      networkError: true,
      networkErrorCode: err.code || null,
    };
  }
}
/* =========================================================
 * MAIN
 * ========================================================= */

async function main() {
  console.log("========================================");
  console.log("FSE CDA VALIDATOR");
  console.log("========================================");

  // 1) Check file esistenza
  const missing = [];
  if (!fileExists(CONFIG.authP12Path)) missing.push(`authP12Path: ${CONFIG.authP12Path}`);
  if (!fileExists(CONFIG.signP12Path)) missing.push(`signP12Path: ${CONFIG.signP12Path}`);
  if (!fileExists(CONFIG.xmlPath)) missing.push(`xmlPath: ${CONFIG.xmlPath}`);
  if (CONFIG.pdfPath && !fileExists(CONFIG.pdfPath)) missing.push(`pdfPath: ${CONFIG.pdfPath}`);

  if (missing.length) {
    console.error("File mancanti:");
    for (const m of missing) console.error(" - " + m);
    process.exit(1);
  }

  // 2) Parsing p12 firma
  console.log("\n[1] Estrazione chiave/certificato da sign.p12...");
  const signMaterial = extractKeyAndCertFromP12(
    CONFIG.signP12Path,
    CONFIG.signP12Password
  );
  const signCn = getCertificateCommonName(signMaterial.certificateObj);
  const signSerial = getCertificateSerialNumber(signMaterial.certificateObj);
  const signValidity = getCertificateValidity(signMaterial.certificateObj);

  console.log("CN certificato firma:", signCn);
  console.log("Serial certificato firma:", signSerial);
  console.log("Validità firma:", signValidity);

  if (!signCn) {
    throw new Error("Impossibile ricavare il Common Name dal certificato di firma");
  }

  // 3) Verifica locale XML
  console.log("\n[2] Verifica locale XML CDA...");
  const xmlValidation = localValidateXml(CONFIG.xmlPath);
  console.log(pretty(xmlValidation));

  // 4) Generazione JWT
  console.log("\n[3] Generazione JWT...");
  const authPayload = buildJwtPayload("auth", signCn);
  const signPayload = buildJwtPayload("integrity", signCn);

  const authJwt = generateJwt(
    signMaterial.privateKeyPem,
    authPayload,
    signMaterial.certificatePem
  );
  const signatureJwt = generateJwt(
    signMaterial.privateKeyPem,
    signPayload,
    signMaterial.certificatePem
  );

  console.log("Authorization JWT generato.");
  console.log("FSE-JWT-Signature generato.");
  console.log("Authorization JWT preview:", authJwt.substring(0, 80) + "...");
  console.log("FSE-JWT-Signature preview:", signatureJwt.substring(0, 80) + "...");

  // 5) Se non c'è PDF, termina qui
  if (!CONFIG.pdfPath) {
    console.log("\n[4] Nessun PDF configurato: salto chiamata remota.");
    console.log("Controllo locale completato.");
    return;
  }

  // 6) Chiamata remota
  console.log("\n[4] Chiamata remota /v1/documents/validation...");
  const authP12Buffer = fs.readFileSync(CONFIG.authP12Path);

  const remoteResult = await callValidationEndpoint(
    authP12Buffer,
    CONFIG.authP12Password,
    authJwt,
    signatureJwt
  );

  console.log("\n=== RISPOSTA REMOTA ===");
  console.log("HTTP STATUS:", remoteResult.status);
  console.log("HEADERS:", pretty(remoteResult.headers));
  console.log("BODY:", pretty(remoteResult.data));
  const extractedTitle = remoteResult?.data?.title || null;
  const extractedDetail = remoteResult?.data?.detail || null;
  const userMessage = extractErrorMessageForUser(remoteResult);

  console.log("\n=== ESTRATTI UTILI ===");
  console.log("testCaseId:", CONFIG.testCaseId);
  console.log("ts:", formatIsoTimestampWith7Digits());
  console.log("traceId:", extractTraceId(remoteResult));
  console.log("workflowInstanceId:", extractWorkflowInstanceId(remoteResult));
  console.log("files:", [path.basename(CONFIG.pdfPath)]);
  console.log("errorTitle:", extractedTitle);
  console.log("errorDetail:", extractedDetail);
  console.log("userMessage:", userMessage);

  if (CONFIG.appendResultToDataJson) {
    const savedEntry = appendResultToDataJson(remoteResult);
    console.log("\n=== RECORD AGGIUNTO A data.json ===");
    console.log(pretty(savedEntry));
    console.log(`data.json aggiornato: ${CONFIG.dataJsonPath}`);
  }

  console.log("\nFINE.");
}

main().catch((err) => {
  console.error("\nERRORE FATALE:");
  console.error(err.message);
  if (err.response) {
    console.error("HTTP STATUS:", err.response.status);
    console.error("HTTP DATA:", pretty(err.response.data));
  }
  process.exit(1);
});