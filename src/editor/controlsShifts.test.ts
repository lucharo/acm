import { describe, expect, test } from "bun:test";
import { controlsShifts } from "./criticMarkupView";

const pair = (left: number, top = 100, height = 15) => ({ left, top, width: 30, height });

describe("floating accept and reject pairs on one line", () => {
  test("a pair that would cover the one before moves just clear of it", () => {
    expect(controlsShifts([pair(0), pair(10)], 0, 1000)).toEqual([0, 22]);
  });

  test("a run of pairs moves along one after another", () => {
    expect(controlsShifts([pair(0), pair(10), pair(20)], 0, 1000)).toEqual([0, 22, 44]);
  });

  test("a pair already clear of the one before stays in place", () => {
    expect(controlsShifts([pair(0), pair(50)], 0, 1000)).toEqual([0, 0]);
  });

  test("a pair clears a neighbour that has itself moved", () => {
    expect(controlsShifts([pair(0), pair(10), pair(45)], 0, 1000)).toEqual([0, 22, 19]);
  });

  test("a new visual row starts clean", () => {
    expect(controlsShifts([pair(0, 100), pair(10, 130)], 0, 1000)).toEqual([0, 0]);
  });

  test("pairs of different sizes that overlap vertically count as one row", () => {
    expect(controlsShifts([pair(0, 100, 20), pair(10, 110, 15)], 0, 1000)).toEqual([0, 22]);
  });

  test("a row that reaches the right edge moves back without covering a pair", () => {
    expect(controlsShifts([pair(50), pair(60)], 0, 100)).toEqual([-12, 10]);
  });

  test("a row running past the right edge stays in order and apart", () => {
    expect(controlsShifts([pair(40), pair(50), pair(60)], 0, 120)).toEqual([-14, 8, 30]);
  });

  test("the right edge only moves pairs on its own row", () => {
    expect(controlsShifts([pair(60, 100), pair(70, 130)], 0, 100)).toEqual([0, 0]);
  });

  test("a pair held at the left edge pushes the next pair clear", () => {
    expect(controlsShifts([pair(-10), pair(10)], 0, 1000)).toEqual([10, 22]);
  });

  test("a row too long for the line never leaves its left edge", () => {
    expect(controlsShifts([pair(10), pair(20), pair(30)], 10, 70)).toEqual([0, -10, 10]);
  });
});
