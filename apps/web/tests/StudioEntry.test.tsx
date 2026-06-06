import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { StudioEntry } from "../src/components/StudioEntry";

describe("StudioEntry", () => {
  it("renders creative materials as a calm internal workspace", () => {
    render(<StudioEntry />);

    expect(screen.getByRole("heading", { name: "创作资料" })).toBeTruthy();
    expect(screen.getByText("工程概览")).toBeTruthy();
    expect(screen.getByText("工程档案")).toBeTruthy();
    expect(screen.getByText("创作笔记")).toBeTruthy();
    expect(screen.getByText("Demo 音频")).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到导航页" }).getAttribute("href")).toBe("/");
  });
});
