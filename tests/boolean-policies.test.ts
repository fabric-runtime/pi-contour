import { describe, expect, it } from "vitest";
import { lease } from "../src/verified/lease.js";
import { snapshot } from "../src/verified/snapshot.js";
import { observer } from "../src/verified/observer.js";
import { prune } from "../src/verified/prune.js";
import { evidence } from "../src/verified/evidence.js";

describe("complete generated Boolean domains", () => {
  it("matches independent predicates for every input combination", () => {
    for (let mask = 0; mask < 32; mask++) {
      const a = !!(mask & 1),
        b = !!(mask & 2),
        c = !!(mask & 4),
        d = !!(mask & 8),
        e = !!(mask & 16);
      expect(lease({ epochSame: a, leaseSame: b, present: c })).toEqual({
        valid: a && b && c,
      });
      expect(snapshot({ baselineSame: a, targetSame: b })).toEqual({
        valid: a && b,
      });
      expect(
        observer({
          stopped: a,
          busy: b,
          pending: c,
          preempt: d,
          generationSame: e,
        }),
      ).toEqual({
        launch: !a && !b,
        queue: !a && b,
        abort: !a && b && d,
        rescan: !a && (c || !e),
      });
      expect(
        prune({
          protected: a,
          removable: b,
          pressure: c,
          expired: d,
          oversized: e,
        }),
      ).toEqual({ remove: !a && b && (c || d || e) });
      expect(evidence({ explicit: a, direct: b, ambiguous: c })).toEqual({
        blocking: a && b && !c,
      });
    }
  });
  it("rejects non-Boolean values rather than indexing outside the finite domain", () => {
    expect(() =>
      lease({
        epochSame: 2 as unknown as boolean,
        leaseSame: true,
        present: true,
      }),
    ).toThrow();
  });
});
