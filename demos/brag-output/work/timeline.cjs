var B = 0.625;
var b = function (n) { return +(n * B).toFixed(6); };
var TL = {
  fps: 30,
  duration: b(72),
  bpm: 96,
  scenes: {
    s1: [0, b(12)],
    s2: [b(12), b(18)],
    s3: [b(18), b(34)],
    s4: [b(34), b(46)],
    s5: [b(46), b(56)],
    s6: [b(56), b(66)],
    s7: [b(66), b(72)],
  },
  hook: [
    [0, b(0), "Agents"], [0, b(0.5), "do"], [0, b(1), "80%", "hi"], [0, b(1.5), "of the"], [0, b(2), "work."],
    [1, b(3), "What’s"], [1, b(3.5), "left"], [1, b(4), "is"],
    [2, b(5), "understanding,", "hi"], [3, b(6), "judgement,", "hi"], [4, b(7), "and coherence.", "hi"],
  ],
  hookAttr: b(8),
  s2: { parrot: b(12), word: b(12.5), tag: b(13), chips: b(14.5) },
  s3: {
    moveLine: b(19.5), clickLine: b(20), typeStart: b(21), step: B / 12,
    comment: "Use exponential backoff, max 5 tries.",
    moveSave: b(24), clickSave: b(24.5), swap: b(24.75), tipSend: b(25.5), clickSend: b(26.5), revised: b(28), tipApprove: b(30), clickApprove: b(31),
  },
  s4: {
    clickWord: b(36), keys: [b(37), b(37.5)], open: b(37.5), typeStart: b(38), step: B / 12,
    name: "shouldRetry", enter: b(39.5), tipApprove: b(41), clickApprove: b(42),
  },
  s5: {
    typeStart: b(47), step: B / 12, cmd: "/paireto:guided-review", enter: b(49),
    rows: [49.5, 49.75, 50, 50.25, 50.5, 50.75, 51, 51.25, 51.5, 51.75].map(b), clickCs: b(52.5),
  },
  s6: {
    clickCompare: b(58), pickMerge: b(59), clickModes: b(60), pickDelta: b(61), pickReview: b(62),
    closeModes: b(62.5), checks: [b(63), b(63.5)],
  },
  s7: { logo: b(66), line: b(66.5), sub: b(67) },
};
TL.beat = B;
if (typeof module !== "undefined") module.exports = TL;
