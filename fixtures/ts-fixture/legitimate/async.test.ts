// shape: async — the ordering guarantee, which is the whole point of mapSeries.
import { describe, it, expect } from "vitest";
import { mapSeries } from "../src/async";

describe("mapSeries", () => {
  it("keeps results in input order", async () => {
    await expect(mapSeries([1, 2, 3], async (n) => n * 2)).resolves.toEqual([2, 4, 6]);
  });

  it("passes the index alongside the item", async () => {
    await expect(mapSeries(["a", "b"], (item, index) => `${index}:${item}`)).resolves.toEqual(["0:a", "1:b"]);
  });

  it("starts each call only after the previous one settled", async () => {
    const order: string[] = [];
    await mapSeries([1, 2, 3], async (n) => {
      order.push(`start ${n}`);
      await Promise.resolve();
      order.push(`end ${n}`);
    });
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("returns nothing for an empty list", async () => {
    await expect(mapSeries([], async (n) => n)).resolves.toEqual([]);
  });
});
