"use strict";
const {
  Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, PageBreak, Header, Footer,
  PageNumber, NumberFormat, Packer, LevelFormat, convertInchesToTwip,
  VerticalAlign, PageOrientation, TableOfContents, ExternalHyperlink, TabStopType, TabStopPosition
} = require("docx");

// ---------- PALETTE (Gjirafa Warehouse Ops — professional logistics scheme) ----------
const COLOR = {
  dark: "1F2A37",      // charcoal navy - headings
  mid: "3E5C76",       // steel blue - subheadings
  accent: "C15B26",    // warehouse/safety orange - warnings, critical
  accentLight: "FBE7DA",
  lightBg: "F2F4F6",   // table header shading
  bandBg: "F8F9FA",    // zebra rows
  border: "B9C2CC",
  danger: "8B1E1E",
  dangerBg: "F6DEDE",
  ok: "2E5E3E",
  okBg: "E2EFE5",
  white: "FFFFFF",
  text: "222831",
};

const FONT = "Calibri";
const FONT_MONO = "Consolas";

// ---------- basic text helpers ----------
function t(text, opts = {}) {
  return new TextRun({ text: String(text), font: FONT, size: 21, ...opts });
}
function bold(text, opts = {}) { return t(text, { bold: true, ...opts }); }

function p(text, opts = {}) {
  const { runOpts = {}, ...pOpts } = opts;
  return new Paragraph({
    children: [t(text, runOpts)],
    spacing: { after: 120 },
    ...pOpts,
  });
}

function pRuns(runs, opts = {}) {
  return new Paragraph({ children: runs, spacing: { after: 120 }, ...opts });
}

let h1n = 0;
function h1(text, opts = {}) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 480, after: 240 },
    border: { bottom: { color: COLOR.dark, space: 4, style: BorderStyle.SINGLE, size: 8 } },
    ...opts,
  });
}
function h2(text, opts = {}) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 180 }, ...opts });
}
function h3(text, opts = {}) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 260, after: 140 } });
}
function h4(text, opts = {}) {
  return new Paragraph({
    children: [bold(text, { color: COLOR.mid, size: 21 })],
    spacing: { before: 200, after: 100 },
  });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function note(text, kind = "info") {
  const colorMap = { info: COLOR.mid, warn: COLOR.accent, danger: COLOR.danger, ok: COLOR.ok };
  const bgMap = { info: COLOR.lightBg, warn: COLOR.accentLight, danger: COLOR.dangerBg, ok: COLOR.okBg };
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: bgMap[kind] },
    border: {
      left: { color: colorMap[kind], space: 6, style: BorderStyle.SINGLE, size: 24 },
    },
    spacing: { before: 120, after: 160 },
    indent: { left: 120 },
    children: [t(text, { color: colorMap[kind], italics: true })],
  });
}

function needsValidation(text) {
  return note("NEVOJITET VALIDIM: " + text, "warn");
}

// numbered step list (custom numbering, not bullets) — use simple manual numbering for portability
function stepList(steps) {
  return steps.map((s, i) =>
    new Paragraph({
      spacing: { after: 80 },
      indent: { left: 360, hanging: 360 },
      children: [
        bold(`Hapi ${i + 1}. `, { color: COLOR.mid }),
        t(s),
      ],
    })
  );
}

function bulletList(items, opts = {}) {
  return items.map((it) =>
    new Paragraph({
      bullet: { level: 0 },
      spacing: { after: 60 },
      children: Array.isArray(it) ? it : [t(it)],
      ...opts,
    })
  );
}

// ---------- table helpers ----------
function cell(content, opts = {}) {
  const {
    width, shading, bold: isBold, color, align = AlignmentType.LEFT,
    valign = VerticalAlign.CENTER, colSpan, rowSpan, size = 20, italics = false,
  } = opts;
  const children = Array.isArray(content)
    ? content
    : [new Paragraph({
        alignment: align,
        children: [new TextRun({ text: String(content), bold: isBold, color, font: FONT, size, italics })],
      })];
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: shading ? { type: ShadingType.CLEAR, fill: shading } : undefined,
    verticalAlign: valign,
    columnSpan: colSpan,
    rowSpan: rowSpan,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children,
  });
}

function headerCell(text, width) {
  return cell(text, { width, shading: COLOR.dark, bold: true, color: COLOR.white, size: 20 });
}

// widths: array of DXA numbers; rows: array of arrays of cell() or strings
function dataTable(widths, headerRow, rows, opts = {}) {
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  const trs = [];
  trs.push(new TableRow({
    tableHeader: true,
    children: headerRow.map((h, i) => headerCell(h, widths[i])),
  }));
  rows.forEach((r, ri) => {
    trs.push(new TableRow({
      cantSplit: true,
      children: r.map((c, ci) => {
        if (c instanceof TableCell) return c;
        const isCellSpec = c && typeof c === "object" && !Array.isArray(c) && "content" in c;
        const base = { width: widths[ci], shading: ri % 2 === 1 ? COLOR.bandBg : undefined };
        if (isCellSpec) return cell(c.content, { ...base, ...c });
        return cell(c, base);
      }),
    }));
  });
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: widths,
    rows: trs,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLOR.border },
    },
    ...opts,
  });
}

function tableWrap(table) {
  return [table, new Paragraph({ spacing: { after: 200 }, children: [] })];
}

// IF/THEN decision block
function ifThen(condition, thenSteps, opts = {}) {
  const out = [];
  out.push(new Paragraph({
    spacing: { before: 160, after: 60 },
    shading: { type: ShadingType.CLEAR, fill: COLOR.accentLight },
    indent: { left: 60 },
    children: [bold("NËSE (IF): ", { color: COLOR.accent }), t(condition, { bold: true })],
  }));
  out.push(new Paragraph({
    spacing: { after: 40 },
    indent: { left: 200 },
    children: [bold("ATËHERË (THEN):", { color: COLOR.mid })],
  }));
  thenSteps.forEach((s, i) => {
    out.push(new Paragraph({
      indent: { left: 460, hanging: 300 },
      spacing: { after: 40 },
      children: [bold(`${i + 1}. `), t(s)],
    }));
  });
  out.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
  return out;
}

// Physical vs System action pairs
function physSys(pairs) {
  const widths = [1600, 4200, 4200];
  const rows = pairs.map((pr) => [
    { content: pr.step, bold: true, shading: COLOR.lightBg },
    pr.physical,
    pr.system,
  ]);
  return dataTable(widths, ["Faza", "Veprimi Fizik (Physical)", "Veprimi në Sistem (System/WMS)"], rows);
}

module.exports = {
  Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, PageBreak, Header, Footer,
  PageNumber, NumberFormat, Packer, LevelFormat, convertInchesToTwip, VerticalAlign,
  PageOrientation, TableOfContents, ExternalHyperlink, TabStopType, TabStopPosition,
  COLOR, FONT, FONT_MONO,
  t, bold, p, pRuns, h1, h2, h3, h4, pageBreak, note, needsValidation,
  stepList, bulletList, cell, headerCell, dataTable, tableWrap, ifThen, physSys,
};
