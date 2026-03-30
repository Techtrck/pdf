pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ─── STATE ────────────────────────────────────────────────────────────────────
let pdfJsDoc = null;
let pdfBytes = null;  // always Uint8Array
let curPage = 1;
let totalPages = 0;
let zoom = 1.5;
let tool = "sel";
let overlays = {};
let selEl = null;
let mergeFiles = [];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getPDFLib() {
  const lib = window.PDFLib;
  if (!lib || !lib.PDFDocument) {
    throw new Error("pdf-lib is not loaded. Check your internet connection and reload the page.");
  }
  return lib;
}

function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf);
}

function triggerDownload(u8, filename) {
  const blob = new Blob([u8], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function dataUrlToU8(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 4000);
}

function loading(on, msg) {
  const el = document.getElementById("loadingOverlay");
  el.classList.toggle("show", on);
  if (msg) document.getElementById("loadMsg").textContent = msg;
}

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

// ─── INIT (after DOM ready) ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {

  // ─── LOAD PDF ───────────────────────────────────────────────────────────────
  const dropZone = document.getElementById("dropZone");
  const pdfInput = document.getElementById("pdfInput");

  dropZone.addEventListener("click", () => pdfInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("drag-over")
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    loadPDF(e.dataTransfer.files[0]);
  });
  pdfInput.addEventListener("change", (e) => {
    loadPDF(e.target.files[0]);
    pdfInput.value = "";
  });

  // ─── IMAGE INPUT ─────────────────────────────────────────────────────────────
  document.getElementById("imgInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const wrap = document.getElementById("pageWrapper");
    if (!wrap) return toast("Load a PDF first", true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const id = "el_" + Date.now();
      const d = { id, type: "image", x: 50, y: 50, w: 220, h: 160, src: ev.target.result };
      if (!overlays[curPage]) overlays[curPage] = [];
      overlays[curPage].push(d);
      selectEl(buildOverlayEl(d, wrap), d);
      toast("Image added — drag to position!");
    };
    reader.readAsDataURL(file);
  });

  // ─── MERGE INPUT ─────────────────────────────────────────────────────────────
  document.getElementById("mergeInput").addEventListener("change", function () {
    Array.from(this.files).forEach((file) => {
      if (file.type !== "application/pdf") return;
      const reader = new FileReader();
      reader.onload = (e) => {
        mergeFiles.push({ name: file.name, size: file.size, bytes: toU8(e.target.result) });
        renderMergeList();
      };
      reader.readAsArrayBuffer(file);
    });
    this.value = "";
  });

  // ─── DOWNLOAD BUTTON ─────────────────────────────────────────────────────────
  document.getElementById("downloadBtn").addEventListener("click", async () => {
    loading(true, "Saving PDF…");
    try {
      const bytes = await getEditedPdfBytes();
      triggerDownload(bytes, "edited_pdf.pdf");
      toast("PDF downloaded!");
    } catch (e) {
      toast("Error saving: " + e.message, true);
      console.error(e);
    }
    loading(false);
  });

  // ─── CANVAS DESELECT ─────────────────────────────────────────────────────────
  document.getElementById("canvasArea").addEventListener("click", (e) => {
    if (e.target.id === "canvasArea" || e.target.id === "pageWrapper") {
      document.querySelectorAll(".overlay-el").forEach((el) => el.classList.remove("selected"));
      selEl = null;
    }
  });

  // ─── CLOSE MODALS ON BACKDROP CLICK ──────────────────────────────────────────
  document.querySelectorAll(".modal-overlay").forEach((o) => {
    o.addEventListener("click", (e) => {
      if (e.target === o) o.classList.remove("show");
    });
  });

}); // end DOMContentLoaded

// ─── LOAD PDF ─────────────────────────────────────────────────────────────────
async function loadPDF(file) {
  if (!file || file.type !== "application/pdf")
    return toast("Please select a PDF file", true);
  loading(true, "Loading PDF…");
  try {
    pdfBytes = toU8(await file.arrayBuffer());
    overlays = {};
    curPage = 1;
    await refreshPdfJs();
    ["toolsSection", "pagesSec", "pageActSec"].forEach(
      (id) => (document.getElementById(id).style.display = "")
    );
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("downloadBtn").disabled = false;
    await buildThumbs();
    await renderPage(1);
    toast("Loaded — " + totalPages + " page(s)");
  } catch (e) {
    toast("Error loading PDF: " + e.message, true);
    console.error(e);
  }
  loading(false);
}

async function refreshPdfJs() {
  // Copy pdfBytes before passing to pdf.js (it may detach the buffer)
  const copy = pdfBytes.slice(0);
  pdfJsDoc = await pdfjsLib.getDocument({ data: copy }).promise;
  totalPages = pdfJsDoc.numPages;
  document.getElementById("pgCount").textContent = totalPages;
}

// ─── THUMBNAILS ───────────────────────────────────────────────────────────────
async function buildThumbs() {
  const list = document.getElementById("pageThumbs");
  list.innerHTML = "";
  for (let i = 1; i <= totalPages; i++) {
    const wrap = document.createElement("div");
    wrap.className = "page-thumb" + (i === curPage ? " active" : "");
    wrap.dataset.page = i;

    try {
      const pg = await pdfJsDoc.getPage(i);
      const vp = pg.getViewport({ scale: 0.22 });
      const cv = document.createElement("canvas");
      cv.width = vp.width;
      cv.height = vp.height;
      await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      wrap.appendChild(cv);
    } catch (_) {}

    const lbl = document.createElement("div");
    lbl.className = "pg-label";
    lbl.textContent = "Page " + i;
    wrap.appendChild(lbl);

    const del = document.createElement("button");
    del.className = "pg-del";
    del.textContent = "×";
    del.title = "Delete page";
    const pn = i;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deletePage(pn);
    });
    wrap.appendChild(del);

    wrap.addEventListener("click", () => goTo(i));
    list.appendChild(wrap);
  }
}

// ─── RENDER PAGE ──────────────────────────────────────────────────────────────
async function renderPage(pn) {
  document.getElementById("pageWrapper")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "pageWrapper";
  wrap.className = "page-wrapper " + tool;

  const pg = await pdfJsDoc.getPage(pn);
  const vp = pg.getViewport({ scale: zoom });
  wrap.style.width = vp.width + "px";
  wrap.style.height = vp.height + "px";
  const cv = document.createElement("canvas");
  cv.width = vp.width;
  cv.height = vp.height;
  wrap.appendChild(cv);
  await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;

  // Top toolbar (create only once)
  if (!document.getElementById("topBar")) {
    const bar = document.createElement("div");
    bar.id = "topBar";
    bar.className = "toolbar-top";
    bar.innerHTML =
      '<span class="tinfo">Editing PDF</span>' +
      '<div class="pg-nav">' +
        '<button id="prevBtn" onclick="goTo(curPage-1)">&#8249;</button>' +
        '<span id="pgInfo"></span>' +
        '<button id="nextBtn" onclick="goTo(curPage+1)">&#8250;</button>' +
      '</div>' +
      '<select style="background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:11px" onchange="changeZoom(this.value)">' +
        '<option value="1">75%</option>' +
        '<option value="1.5" selected>100%</option>' +
        '<option value="2">133%</option>' +
        '<option value="2.5">167%</option>' +
      '</select>';
    const ca = document.getElementById("canvasArea");
    ca.insertBefore(bar, ca.firstChild);
  }

  document.getElementById("pgInfo").textContent = pn + " / " + totalPages;
  document.getElementById("prevBtn").disabled = pn <= 1;
  document.getElementById("nextBtn").disabled = pn >= totalPages;

  document.getElementById("canvasArea").appendChild(wrap);

  // Click to add text
  wrap.addEventListener("click", (e) => {
    if (tool !== "txt") return;
    if (!e.target.matches("canvas") && e.target !== wrap) return;
    const r = wrap.getBoundingClientRect();
    addText(e.clientX - r.left, e.clientY - r.top, wrap);
    setTool("sel");
  });

  if (!overlays[pn]) overlays[pn] = [];
  overlays[pn].forEach((d) => buildOverlayEl(d, wrap));
}

// ─── OVERLAY ELEMENTS ─────────────────────────────────────────────────────────
function buildOverlayEl(d, wrap) {
  const el = document.createElement("div");
  el.className = "overlay-el";
  el.style.left = d.x + "px";
  el.style.top = d.y + "px";
  el.style.width = d.w + "px";
  el.style.height = d.h + "px";
  el.dataset.id = d.id;

  if (d.type === "image") {
    const img = document.createElement("img");
    img.src = d.src;
    el.appendChild(img);
  } else {
    const td = document.createElement("div");
    td.className = "el-text";
    td.style.fontSize = d.fontSize + "px";
    td.style.color = d.color;
    td.style.fontWeight = d.fontWeight;
    td.style.fontFamily = "Manrope, sans-serif";
    td.textContent = d.text;
    el.appendChild(td);
  }

  const db = document.createElement("button");
  db.className = "delbtn";
  db.textContent = "×";
  db.addEventListener("click", (e) => { e.stopPropagation(); removeEl(d.id); });
  el.appendChild(db);

  const rh = document.createElement("div");
  rh.className = "rszh";
  rh.addEventListener("mousedown", (e) => startResize(e, el, d));
  el.appendChild(rh);

  el.addEventListener("mousedown", (e) => {
    if (e.target === db || e.target === rh) return;
    selectEl(el, d);
    startDrag(e, el, d);
  });

  wrap.appendChild(el);
  return el;
}

function addText(x, y, wrap) {
  const id = "el_" + Date.now();
  const d = {
    id, type: "text", x, y, w: 200, h: 40,
    text: document.getElementById("txContent").value || "Your text",
    fontSize: parseInt(document.getElementById("txSize").value) || 18,
    color: document.getElementById("txColor").value,
    fontWeight: document.getElementById("txWeight").value,
  };
  if (!overlays[curPage]) overlays[curPage] = [];
  overlays[curPage].push(d);
  selectEl(buildOverlayEl(d, wrap), d);
}

function selectEl(el, d) {
  document.querySelectorAll(".overlay-el").forEach((e) => e.classList.remove("selected"));
  el.classList.add("selected");
  selEl = { el, d };
  const isText = d.type === "text";
  document.getElementById("textOpts").style.display = isText ? "" : "none";
  if (isText) {
    document.getElementById("txContent").value = d.text;
    document.getElementById("txSize").value = d.fontSize;
    document.getElementById("txColor").value = d.color;
    document.getElementById("txWeight").value = d.fontWeight;
  }
}

function updateTxt() {
  if (!selEl || selEl.d.type !== "text") return;
  const d = selEl.d;
  d.text = document.getElementById("txContent").value;
  d.fontSize = parseInt(document.getElementById("txSize").value);
  d.color = document.getElementById("txColor").value;
  d.fontWeight = document.getElementById("txWeight").value;
  const td = selEl.el.querySelector(".el-text");
  if (td) {
    td.textContent = d.text;
    td.style.fontSize = d.fontSize + "px";
    td.style.color = d.color;
    td.style.fontWeight = d.fontWeight;
  }
}

function startDrag(e, el, d) {
  if (tool !== "sel") return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = d.x, oy = d.y;
  const mv = (ev) => {
    d.x = ox + (ev.clientX - sx);
    d.y = oy + (ev.clientY - sy);
    el.style.left = d.x + "px";
    el.style.top = d.y + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function startResize(e, el, d) {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX, sy = e.clientY, ow = d.w, oh = d.h;
  const mv = (ev) => {
    d.w = Math.max(40, ow + ev.clientX - sx);
    d.h = Math.max(20, oh + ev.clientY - sy);
    el.style.width = d.w + "px";
    el.style.height = d.h + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function removeEl(id) {
  if (!overlays[curPage]) return;
  overlays[curPage] = overlays[curPage].filter((d) => d.id !== id);
  document.querySelectorAll(".overlay-el").forEach((el) => {
    if (el.dataset.id === id) el.remove();
  });
  selEl = null;
  document.getElementById("textOpts").style.display = "none";
}

function deleteSelected() {
  if (selEl) removeEl(selEl.d.id);
}

function setTool(t) {
  tool = t;
  document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
  if (t === "sel") document.getElementById("toolSelect").classList.add("active");
  if (t === "txt") document.getElementById("toolText").classList.add("active");
  const w = document.getElementById("pageWrapper");
  if (w) w.className = "page-wrapper " + t;
  if (t !== "txt")
    document.getElementById("textOpts").style.display =
      selEl && selEl.d.type === "text" ? "" : "none";
}

// ─── PAGE NAV ─────────────────────────────────────────────────────────────────
async function goTo(n) {
  n = Math.max(1, Math.min(totalPages, n));
  curPage = n;
  document.querySelectorAll(".page-thumb").forEach((t, i) =>
    t.classList.toggle("active", i + 1 === n)
  );
  await renderPage(n);
}

function changeZoom(v) {
  zoom = parseFloat(v);
  renderPage(curPage);
}

// ─── DELETE PAGE ──────────────────────────────────────────────────────────────
async function deletePage(pn) {
  if (totalPages <= 1) return toast("Cannot delete the only page", true);
  if (!confirm("Delete page " + pn + "?")) return;
  loading(true, "Deleting page…");
  try {
    const { PDFDocument } = getPDFLib();
    const doc = await PDFDocument.load(pdfBytes);
    doc.removePage(pn - 1);
    pdfBytes = toU8(await doc.save());

    const nOv = {};
    for (const [k, v] of Object.entries(overlays)) {
      const n = +k;
      if (n < pn) nOv[n] = v;
      else if (n > pn) nOv[n - 1] = v;
    }
    overlays = nOv;

    await refreshPdfJs();
    curPage = Math.min(curPage, totalPages);
    await buildThumbs();
    await renderPage(curPage);
    toast("Page " + pn + " deleted");
  } catch (e) {
    toast("Error deleting page: " + e.message, true);
    console.error(e);
  }
  loading(false);
}

// ─── INSERT BLANK PAGE ────────────────────────────────────────────────────────
function openBlankModal() {
  if (!pdfJsDoc) return toast("Load a PDF first", true);
  const sel = document.getElementById("blankPos");
  sel.innerHTML = "";
  for (let i = 0; i <= totalPages; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent =
      i === 0 ? "Before page 1 (beginning)"
      : i === totalPages ? "After page " + i + " (end)"
      : "After page " + i;
    if (i === curPage) opt.selected = true;
    sel.appendChild(opt);
  }
  document.getElementById("blankModal").classList.add("show");
}

async function doInsertBlank() {
  closeModal("blankModal");
  loading(true, "Inserting blank page…");
  try {
    const { PDFDocument } = getPDFLib();

    const insertAt = parseInt(document.getElementById("blankPos").value, 10);
    const w = parseInt(document.getElementById("blankW").value, 10) || 595;
    const h = parseInt(document.getElementById("blankH").value, 10) || 842;

    const doc = await PDFDocument.load(pdfBytes);
    const count = doc.getPageCount();

    if (insertAt >= count) {
      doc.addPage([w, h]);
    } else {
      doc.insertPage(insertAt, [w, h]);
    }
    pdfBytes = toU8(await doc.save());

    const newPageNum = insertAt + 1; // 1-indexed page number of the new blank page
    const nOv = {};
    for (const [k, v] of Object.entries(overlays)) {
      const n = +k;
      nOv[n >= newPageNum ? n + 1 : n] = v;
    }
    overlays = nOv;

    await refreshPdfJs();
    curPage = newPageNum;
    await buildThumbs();
    await renderPage(curPage);
    toast("Blank page inserted as page " + curPage);
  } catch (e) {
    toast("Error inserting blank page: " + e.message, true);
    console.error(e);
  }
  loading(false);
}

// ─── MERGE ────────────────────────────────────────────────────────────────────
function openMergeModal() {
  if (!pdfJsDoc) return toast("Load a PDF first", true);
  mergeFiles = [];
  renderMergeList();
  document.getElementById("mergeModal").classList.add("show");
}

function renderMergeList() {
  const list = document.getElementById("mergeList");
  if (!mergeFiles.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:6px 0">No extra files yet.</div>';
    return;
  }
  list.innerHTML = "";
  mergeFiles.forEach(function (f, i) {
    const item = document.createElement("div");
    item.className = "merge-item";

    const icon = document.createElement("span");
    icon.textContent = "📄";

    const name = document.createElement("span");
    name.className = "mname";
    name.title = f.name;
    name.textContent = f.name;

    const size = document.createElement("span");
    size.className = "msize";
    size.textContent = Math.round(f.size / 1024) + "KB";

    const ord = document.createElement("div");
    ord.className = "mord";

    const up = document.createElement("button");
    up.textContent = "↑";
    if (i === 0) up.disabled = true;
    up.addEventListener("click", function () { moveMerge(i, -1); });

    const dn = document.createElement("button");
    dn.textContent = "↓";
    if (i === mergeFiles.length - 1) dn.disabled = true;
    dn.addEventListener("click", function () { moveMerge(i, 1); });

    ord.appendChild(up);
    ord.appendChild(dn);

    const rm = document.createElement("button");
    rm.className = "mrm";
    rm.textContent = "×";
    rm.addEventListener("click", function () { removeMerge(i); });

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(size);
    item.appendChild(ord);
    item.appendChild(rm);
    list.appendChild(item);
  });
}

function moveMerge(i, d) {
  const j = i + d;
  if (j < 0 || j >= mergeFiles.length) return;
  const tmp = mergeFiles[i];
  mergeFiles[i] = mergeFiles[j];
  mergeFiles[j] = tmp;
  renderMergeList();
}

function removeMerge(i) {
  mergeFiles.splice(i, 1);
  renderMergeList();
}

async function doMerge() {
  if (!mergeFiles.length) return toast("Add at least one more PDF to merge", true);
  closeModal("mergeModal");
  loading(true, "Merging PDFs…");
  try {
    const { PDFDocument } = getPDFLib();
    const out = await PDFDocument.create();
    const pos = document.getElementById("mergePos").value;

    const currentBytes = pdfBytes.slice(0); // use current pdfBytes directly
    const ordered = [];
    if (pos === "first") ordered.push(currentBytes);
    mergeFiles.forEach((f) => ordered.push(f.bytes));
    if (pos === "last") ordered.push(currentBytes);

    for (const bytes of ordered) {
      const src = await PDFDocument.load(bytes);
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((p) => out.addPage(p));
    }

    triggerDownload(toU8(await out.save()), "merged.pdf");
    toast("Merged PDF downloaded!");
  } catch (e) {
    toast("Merge failed: " + e.message, true);
    console.error(e);
  }
  loading(false);
}

// ─── SPLIT ────────────────────────────────────────────────────────────────────
function openSplitModal() {
  if (!pdfJsDoc) return toast("Load a PDF first", true);
  const list = document.getElementById("splitList");
  list.innerHTML = "";
  for (let i = 1; i <= totalPages; i++) {
    const item = document.createElement("div");
    item.className = "split-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "sp" + i;
    cb.value = i;
    cb.checked = true;

    const lbl = document.createElement("label");
    lbl.htmlFor = "sp" + i;
    lbl.textContent = "Page " + i;

    item.appendChild(cb);
    item.appendChild(lbl);
    list.appendChild(item);
  }
  document.getElementById("splitModal").classList.add("show");
}

function splitAll(v) {
  document.querySelectorAll("#splitList input").forEach((cb) => (cb.checked = v));
}

async function doSplit() {
  const checked = Array.from(document.querySelectorAll("#splitList input:checked")).map((cb) => +cb.value);
  if (!checked.length) return toast("Select at least one page", true);
  closeModal("splitModal");
  const mode = document.getElementById("splitMode").value;
  loading(true, "Splitting PDF…");
  try {
    const { PDFDocument } = getPDFLib();
    const srcBytes = pdfBytes.slice(0); // snapshot

    if (mode === "each") {
      for (const pn of checked) {
        const src = await PDFDocument.load(srcBytes);
        const out = await PDFDocument.create();
        const [pg] = await out.copyPages(src, [pn - 1]);
        out.addPage(pg);
        triggerDownload(toU8(await out.save()), "page_" + pn + ".pdf");
        await new Promise((r) => setTimeout(r, 300));
      }
      toast(checked.length + " page(s) downloaded separately");
    } else {
      const src = await PDFDocument.load(srcBytes);
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, checked.map((n) => n - 1));
      pages.forEach((p) => out.addPage(p));
      triggerDownload(toU8(await out.save()), "split_pages.pdf");
      toast(checked.length + " page(s) extracted");
    }
  } catch (e) {
    toast("Split failed: " + e.message, true);
    console.error(e);
  }
  loading(false);
}

// ─── DOWNLOAD WITH OVERLAYS EMBEDDED ─────────────────────────────────────────
async function getEditedPdfBytes() {
  const { PDFDocument, rgb } = getPDFLib();
  const doc = await PDFDocument.load(pdfBytes.slice(0));
  const pages = doc.getPages();

  for (let pn = 1; pn <= totalPages; pn++) {
    const els = overlays[pn] || [];
    if (!els.length) continue;

    const pdfPg = pages[pn - 1];
    const { width: pW, height: pH } = pdfPg.getSize();

    // Get the viewport dimensions from pdf.js for coordinate mapping
    const pg = await pdfJsDoc.getPage(pn);
    const vp = pg.getViewport({ scale: zoom });
    const sx = pW / vp.width;
    const sy = pH / vp.height;

    for (const el of els) {
      const x = el.x * sx;
      const y = pH - el.y * sy - el.h * sy;
      const w = el.w * sx;
      const h = el.h * sy;

      if (el.type === "image") {
        try {
          const u8 = dataUrlToU8(el.src);
          let img;
          try { img = await doc.embedPng(u8); } catch { img = await doc.embedJpg(u8); }
          pdfPg.drawImage(img, { x, y, width: w, height: h });
        } catch (ie) {
          console.warn("image embed failed", ie);
        }
      } else {
        const hx = el.color || "#000000";
        const r = parseInt(hx.slice(1, 3), 16) / 255;
        const g = parseInt(hx.slice(3, 5), 16) / 255;
        const b = parseInt(hx.slice(5, 7), 16) / 255;
        pdfPg.drawText(el.text, {
          x,
          y: y + h * 0.3,
          size: Math.max(4, el.fontSize * sx),
          color: rgb(r, g, b),
        });
      }
    }
  }

  return toU8(await doc.save());
}
