// shape: async — await the result and assert it, and assert ordering where order is part of the
// contract. No timers and no clock.
import { describe, it, expect } from "vitest";
import { mapSeries } from "../src/async";

describe("mapSeries", () => {
  it("resolves to the mapped values in input order", async () => {
    expect(await mapSeries([1, 2, 3], async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  it("passes the index alongside the item", async () => {
    expect(await mapSeries(["a", "b"], (item, index) => `${index}:${item}`)).toEqual(["0:a", "1:b"]);
  });

  it("awaits each call before starting the next", async () => {
    const order: string[] = [];
    await mapSeries([1, 2, 3], async (n) => {
      order.push(`start ${n}`);
      await Promise.resolve();
      order.push(`end ${n}`);
      return n;
    });
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });
});
