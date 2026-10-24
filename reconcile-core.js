// reconcile-core.js
// Bank-to-receipt matching. Pure functions, no DOM, so app.html and Node tests use the same code.
//
// Rules:
//  - AUTO-MATCH only when: amount equal to the cent, dates within 3 days,
//    descriptions share at least half their significant words, and exactly one
//    unused receipt qualifies. Nothing else is applied automatically.
//  - REVIEW: same amount within 5 days, but the description does not agree or
//    more than one receipt qualifies. A person confirms one of the candidates.
//  - MISSING: a bank line with no candidate at all.
//  - ORPHAN: a receipt not auto-matched. It may still be confirmed from review.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReconCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const AMOUNT_TOLERANCE = 0.005;   // half a kobo: equal to the cent
  const AUTO_DAY_WINDOW = 3;
  const REVIEW_DAY_WINDOW = 5;
  const WORD_OVERLAP_MIN = 0.5;

  function parseAppDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    let y = m[3];
    if (y.length === 2) y = "20" + y;
    return new Date(+y, +m[2] - 1, +m[1]);
  }

  function crudeStem(w) {
    if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
    if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
    if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
    if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
    if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
    return w;
  }

  function wordSet(s) {
    return new Set(String(s || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2).map(crudeStem));
  }

  // Share of the smaller word set that appears in the other. 0 if either is empty.
  function wordOverlap(a, b) {
    const wa = wordSet(a), wb = wordSet(b);
    if (!wa.size || !wb.size) return 0;
    let hit = 0;
    wa.forEach((w) => { if (wb.has(w)) hit++; });
    return hit / Math.min(wa.size, wb.size);
  }

  // Returns null if the pair is not even a review candidate.
  function assess(bank, tx) {
    const txAmt = Math.abs(parseFloat(tx.amount) || 0);
    const amtDiff = Math.abs(txAmt - (bank.amount || 0));
    if (amtDiff > AMOUNT_TOLERANCE) return null;
    const txDate = parseAppDate(tx.date);
    if (!bank.date || !txDate) return null;
    const dayDiff = Math.abs((bank.date - txDate) / 86400000);
    if (dayDiff > REVIEW_DAY_WINDOW) return null;
    const sim = wordOverlap(bank.description, tx.description || tx.sender || "");
    const autoOk = dayDiff <= AUTO_DAY_WINDOW && sim >= WORD_OVERLAP_MIN;
    return { dayDiff, sim, autoOk };
  }

  // bankRows: [{date: Date, description, amount, type}]
  // transactions: receipt rows [{date: "DD/MM/YYYY", amount, description}]
  function matchBankRows(bankRows, transactions) {
    const usedTx = new Set();
    const matched = [];
    const review = [];
    const missing = [];

    bankRows.forEach((bank) => {
      const candidates = [];
      const autoIdx = [];
      transactions.forEach((tx, i) => {
        if (usedTx.has(i)) return;
        const a = assess(bank, tx);
        if (!a) return;
        candidates.push({ index: i, tx, dayDiff: a.dayDiff, sim: a.sim });
        if (a.autoOk) autoIdx.push(i);
      });

      if (autoIdx.length === 1) {
        const i = autoIdx[0];
        usedTx.add(i);
        matched.push({ bank, tx: transactions[i] });
        return;
      }
      if (candidates.length) {
        // Ambiguous or weak: a person must choose. Best candidates first.
        candidates.sort((x, y) => (y.sim - x.sim) || (x.dayDiff - y.dayDiff));
        review.push({ bank, candidates });
      } else {
        missing.push(bank);
      }
    });

    const matchedIdx = new Set(matched.map((m) => transactions.indexOf(m.tx)));
    const orphans = transactions.filter((_, i) => !matchedIdx.has(i));
    return { matched, review, missing, orphans };
  }

  // Apply a human choice: move a review line into matched.
  // reconResult is mutated and returned. Returns false if the choice is not valid.
  function confirmReview(reconResult, reviewIndex, txIndex) {
    const item = reconResult.review[reviewIndex];
    if (!item) return false;
    const cand = item.candidates.find((c) => c.index === txIndex);
    if (!cand) return false;
    reconResult.matched.push({ bank: item.bank, tx: cand.tx });
    reconResult.review.splice(reviewIndex, 1);
    reconResult.orphans = reconResult.orphans.filter((t) => t !== cand.tx);
    // A receipt confirmed here must not appear as a candidate for other review lines.
    reconResult.review.forEach((r) => {
      r.candidates = r.candidates.filter((c) => c.tx !== cand.tx);
    });
    return true;
  }

  return {
    parseAppDate, wordOverlap, assess, matchBankRows, confirmReview,
    AMOUNT_TOLERANCE, AUTO_DAY_WINDOW, REVIEW_DAY_WINDOW,
  };
});
