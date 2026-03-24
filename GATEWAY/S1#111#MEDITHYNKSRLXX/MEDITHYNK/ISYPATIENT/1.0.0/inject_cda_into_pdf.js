#!/usr/bin/env node

/**
 * inject_cda_into_pdf.js
 *
 * Crea un PDF/A-3b con il CDA XML iniettato come file allegato (embedded file),
 * conforme ai requisiti del Gateway FSE 2.0 (Sogei/Ministero della Salute).
 *
 * Il gateway si aspetta:
 *  - Un PDF con il CDA XML allegato come EmbeddedFile
 *  - Il file allegato deve chiamarsi "cda.xml" (case insensitive)
 *  - Il PDF deve avere l'AF (Associated Files) entry che punta all'allegato
 *  - Relationship: "Source" (come da spec PDF/A-3)
 *
 * Dipendenze:
 *   npm install pdf-lib
 *
 * Uso:
 *   node inject_cda_into_pdf.js
 *
 * Output: output.pdf (pronto per essere inviato al gateway)
 */

const fs = require("fs");
const path = require("path");
const { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFStream, PDFHexString, PDFNumber, PDFRawStream } = require("pdf-lib");

/* =========================================================
 * CONFIG
 * ========================================================= */
const CONFIG = {
  // CDA XML da iniettare
  cdaXmlPath: "./RSA.xml",

  // PDF di base da cui partire.
  // Se non hai un PDF esistente, metti "" e lo script ne crea uno vuoto
  // con una pagina che mostra il testo del documento.
  inputPdfPath: "RSA.pdf",

  // Output
  outputPdfPath: "./RSA_TESTCASE_1.pdf",

  // Metadati del PDF (opzionali ma consigliati)
  title: "Referto di Specialistica Ambulatoriale",
  author: "Sistema Sanitario",
  subject: "CDA2 - RSA",
  creator: "FSE Integration - pdf-lib",
};

/* =========================================================
 * HELPERS
 * ========================================================= */

/**
 * Aggiunge manualmente i metadati XMP PDF/A-3b al documento.
 * pdf-lib non supporta nativamente PDF/A, quindi inseriamo
 * lo stream XMP a mano come richiesto dallo standard.
 */
function buildXmpMetadata(title, author, subject) {
  const now = new Date().toISOString();
  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="pdf-lib + custom">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">

    <!-- Identificazione PDF/A -->
    <rdf:Description rdf:about=""
      xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>

    <!-- Metadati Dublin Core -->
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:creator>
        <rdf:Seq>
          <rdf:li>${escapeXml(author)}</rdf:li>
        </rdf:Seq>
      </dc:creator>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escapeXml(subject)}</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>

    <!-- XMP Basic -->
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>${now}</xmp:CreateDate>
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
      <xmp:MetadataDate>${now}</xmp:MetadataDate>
      <xmp:CreatorTool>${escapeXml(CONFIG.creator)}</xmp:CreatorTool>
    </rdf:Description>

    <!-- PDF Info -->
    <rdf:Description rdf:about=""
      xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>pdf-lib (FSE CDA injector)</pdf:Producer>
    </rdf:Description>

  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  return xmp;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* =========================================================
 * MAIN
 * ========================================================= */
async function main() {
  console.log("==============================================");
  console.log("FSE CDA → PDF/A-3b Injector");
  console.log("==============================================");

  // 1) Leggi il CDA XML
  if (!fs.existsSync(CONFIG.cdaXmlPath)) {
    console.error(`ERRORE: CDA XML non trovato: ${CONFIG.cdaXmlPath}`);
    process.exit(1);
  }
  const cdaXmlBytes = fs.readFileSync(CONFIG.cdaXmlPath);
  console.log(`[1] CDA XML letto: ${cdaXmlBytes.length} bytes`);

  // 2) Crea o carica il PDF base
  let pdfDoc;
  if (CONFIG.inputPdfPath && fs.existsSync(CONFIG.inputPdfPath)) {
    console.log(`[2] Carico PDF esistente: ${CONFIG.inputPdfPath}`);
    const existingPdfBytes = fs.readFileSync(CONFIG.inputPdfPath);
    pdfDoc = await PDFDocument.load(existingPdfBytes, { ignoreEncryption: true });
  } else {
    console.log(`[2] Creo PDF vuoto con pagina placeholder...`);
    pdfDoc = await PDFDocument.create();

    // Aggiungi una pagina con testo descrittivo
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();

    // Testo base (font standard, nessuna dipendenza esterna)
    page.drawText(CONFIG.title, {
      x: 50,
      y: height - 80,
      size: 16,
    });
    page.drawText("Documento CDA2 - Fascicolo Sanitario Elettronico", {
      x: 50,
      y: height - 110,
      size: 11,
    });
    page.drawText(`Generato il: ${new Date().toLocaleString("it-IT")}`, {
      x: 50,
      y: height - 135,
      size: 10,
    });
    page.drawText("Il referto clinico è contenuto nel file allegato cda.xml", {
      x: 50,
      y: height - 160,
      size: 10,
    });
  }

  // 3) Imposta metadati PDF standard
  pdfDoc.setTitle(CONFIG.title);
  pdfDoc.setAuthor(CONFIG.author);
  pdfDoc.setSubject(CONFIG.subject);
  pdfDoc.setCreator(CONFIG.creator);
  pdfDoc.setProducer("pdf-lib (FSE CDA injector)");
  pdfDoc.setCreationDate(new Date());
  pdfDoc.setModificationDate(new Date());

  console.log(`[3] Metadati PDF impostati`);

  // 4) Inietta XMP PDF/A-3b metadata stream
  const xmpString = buildXmpMetadata(CONFIG.title, CONFIG.author, CONFIG.subject);
  const xmpBytes = Buffer.from(xmpString, "utf-8");

  const xmpStreamDict = pdfDoc.context.obj({
    Type: "Metadata",
    Subtype: "XML",
    Length: xmpBytes.length,
  });

  const xmpStream = pdfDoc.context.stream(xmpBytes, {
    Type: "Metadata",
    Subtype: "XML",
  });

  const xmpRef = pdfDoc.context.register(xmpStream);
  pdfDoc.catalog.set(PDFName.of("Metadata"), xmpRef);

  console.log(`[4] XMP PDF/A-3b metadata stream iniettato`);

  // 5) Crea l'EmbeddedFile stream per il CDA XML
  //    Struttura richiesta da PDF/A-3:
  //    EmbeddedFile stream con Params (ModDate, Size, CheckSum)
  const now = new Date();
  const pdfDateStr = formatPdfDate(now);

  const embeddedFileStream = pdfDoc.context.stream(cdaXmlBytes, {
    Type: "EmbeddedFile",
    Subtype: "text/xml",           // MIME type
    Length: cdaXmlBytes.length,
    Params: pdfDoc.context.obj({
      Size: cdaXmlBytes.length,
      ModDate: PDFString.of(pdfDateStr),
    }),
  });

  const embeddedFileRef = pdfDoc.context.register(embeddedFileStream);

  console.log(`[5] EmbeddedFile stream creato per cda.xml`);

  // 6) Crea il FileSpec dictionary
  //    AFRelationship: "Source" come richiesto da FSE/HL7
  const fileSpecDict = pdfDoc.context.obj({
    Type: "Filespec",
    F: PDFString.of("cda.xml"),
    UF: PDFString.of("cda.xml"),
    Desc: PDFString.of("CDA Document"),
    AFRelationship: "Source",
    EF: pdfDoc.context.obj({
      F: embeddedFileRef,
      UF: embeddedFileRef,
    }),
  });

  const fileSpecRef = pdfDoc.context.register(fileSpecDict);

  console.log(`[6] FileSpec dictionary creato`);

  // 7) Aggiungi il FileSpec ai Names/EmbeddedFiles del catalogo
  //    Struttura: Catalog > Names > EmbeddedFiles > Names [string, filespec, ...]
  const embeddedFilesDict = pdfDoc.context.obj({
    Names: pdfDoc.context.obj([PDFString.of("cda.xml"), fileSpecRef]),
  });
  const embeddedFilesRef = pdfDoc.context.register(embeddedFilesDict);

  const namesDict = pdfDoc.context.obj({
    EmbeddedFiles: embeddedFilesRef,
  });
  const namesDictRef = pdfDoc.context.register(namesDict);

  pdfDoc.catalog.set(PDFName.of("Names"), namesDictRef);

  console.log(`[7] Names/EmbeddedFiles aggiunto al catalogo`);

  // 8) Aggiungi AF (Associated Files) entry al catalogo
  //    Questo è obbligatorio per PDF/A-3 per dichiarare i file associati
  const afArray = pdfDoc.context.obj([fileSpecRef]);
  pdfDoc.catalog.set(PDFName.of("AF"), afArray);

  console.log(`[8] AF (Associated Files) entry aggiunto al catalogo`);

  // 9) Serializza e salva
  console.log(`[9] Serializzazione PDF...`);
  const pdfBytes = await pdfDoc.save();

  fs.writeFileSync(CONFIG.outputPdfPath, pdfBytes);
  console.log(`\n✅ PDF creato: ${CONFIG.outputPdfPath}`);
  console.log(`   Dimensione: ${pdfBytes.length} bytes`);
  console.log(`\nPronto per essere inviato al gateway FSE.`);

  // 10) Verifica quick: rileggi e controlla che l'allegato ci sia
  console.log(`\n[10] Verifica allegato nel PDF generato...`);
  const verifyDoc = await PDFDocument.load(pdfBytes);
  const catalog = verifyDoc.catalog;
  const hasAF = catalog.has(PDFName.of("AF"));
  const hasNames = catalog.has(PDFName.of("Names"));
  const hasMetadata = catalog.has(PDFName.of("Metadata"));

  console.log(`  AF entry presente:       ${hasAF ? "✅" : "❌"}`);
  console.log(`  Names entry presente:    ${hasNames ? "✅" : "❌"}`);
  console.log(`  Metadata XMP presente:   ${hasMetadata ? "✅" : "❌"}`);
}

/* =========================================================
 * UTILS
 * ========================================================= */
function formatPdfDate(date) {
  // Formato PDF date: D:YYYYMMDDHHmmSSOHH'mm'
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // Offset timezone
  const tz = -date.getTimezoneOffset();
  const tzSign = tz >= 0 ? "+" : "-";
  const tzH = pad(Math.floor(Math.abs(tz) / 60));
  const tzM = pad(Math.abs(tz) % 60);
  return `D:${y}${mo}${d}${h}${mi}${s}${tzSign}${tzH}'${tzM}'`;
}

main().catch((err) => {
  console.error("\nERRORE FATALE:", err.message);
  console.error(err.stack);
  process.exit(1);
});
