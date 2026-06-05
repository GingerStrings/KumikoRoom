import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { StudioEntry } from "../src/components/StudioEntry";

describe("StudioEntry", () => {
  it("renders Creative Archive as an internal KumikoRoom area", () => {
    render(<StudioEntry />);

    expect(screen.getByRole("heading", { name: "创作资料室" })).toBeTruthy();
    expect(screen.getByText("工程架")).toBeTruthy();
    expect(screen.getByText("工程档案")).toBeTruthy();
    expect(screen.getByText("创作笔记")).toBeTruthy();
    expect(screen.getByText("Demo 音频")).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到陪伴房间" }).getAttribute("href")).toBe("/room");
  });
});
