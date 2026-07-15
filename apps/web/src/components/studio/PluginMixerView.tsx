"use client";

import { useMemo, useState } from "react";
import type {
  StudioAnalysis,
  StudioAutomationSummary,
  StudioChannelSummary,
  StudioMixerInsertSummary,
  StudioPluginInstance
} from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

export type PluginMixerTarget = {
  type: "channel" | "plugin" | "mixer_insert";
  id: string;
};

interface PluginMixerViewProps {
  analysis: StudioAnalysis;
  selectedTarget?: PluginMixerTarget | null;
  onSelectTarget?: (target: PluginMixerTarget) => void;
}

type PluginKindFilter = "all" | "generator" | "effect" | "unknown";

const MAX_ROUTE_NODES = 64;
const MAX_ROUTE_EDGES = 128;

export function PluginMixerView({ analysis, selectedTarget = null, onSelectTarget }: PluginMixerViewProps) {
  const [kindFilter, setKindFilter] = useState<PluginKindFilter>("all");
  const [localTarget, setLocalTarget] = useState<PluginMixerTarget | null>(null);
  const currentTarget = selectedTarget ?? localTarget;
  const selectTarget = (target: PluginMixerTarget) => {
    setLocalTarget(target);
    onSelectTarget?.(target);
  };
  const visiblePlugins = analysis.plugins.filter((plugin) => kindFilter === "all" || pluginKind(plugin) === kindFilter);
  const activeInserts = analysis.mixerInserts.filter((insert) => insert.slotPluginIds.length > 0 || insert.routeTargetIds.length > 0);

  return (
    <article className={studioCss.analysisView} aria-label="插件、Mixer 与自动化分析">
      <header className={studioCss.analysisViewHeader}>
        <div>
          <p className={studioCss.panelKicker}>SIGNAL INVENTORY</p>
          <h1>Plugin &amp; Mixer</h1>
          <p>按解析快照核对 Channel、插件实例、效果链和可确认的路由关系。</p>
        </div>
        <div className={studioCss.pluginKindFilters} role="group" aria-label="插件类别筛选">
          {(["all", "generator", "effect", "unknown"] as const).map((kind) => (
            <button key={kind} type="button" aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>
              {kindFilterLabel(kind)}
            </button>
          ))}
        </div>
      </header>
      <p className={studioCss.pluginContractNote}>快照未提供原生/第三方来源，只报告生成器、效果器等功能类别。</p>

      <section className={studioCss.signalGrid}>
        <section className={studioCss.signalPanel} aria-labelledby="channel-rack-heading">
          <PanelHeader id="channel-rack-heading" label="CHANNEL RACK" count={analysis.channels.length} />
          {analysis.channels.length > 0 ? (
            <ul className={studioCss.signalRows} aria-label="Channel Rack">
              {analysis.channels.map((channel, channelIndex) => {
                const linked = resolveChannelPlugin(channel, analysis.plugins);
                return (
                  <li key={`${channel.id}-${channelIndex}`} data-selected={isSelected(currentTarget, "channel", channel.id)}>
                    <button type="button" onClick={() => selectTarget({ type: "channel", id: channel.id })}>
                      <strong>{channel.name}</strong><small>{channel.channelType || "类型未知"}</small>
                    </button>
                    <span>{channel.pluginName || "未报告插件"}</span>
                    <em data-resolved={Boolean(linked)}>{linked ? "已关联" : channel.pluginName ? "未解析" : "空"}</em>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyCopy>快照没有报告 Channel。</EmptyCopy>}
        </section>

        <section className={studioCss.signalPanel} aria-labelledby="plugin-table-heading">
          <PanelHeader id="plugin-table-heading" label="PLUGIN INSTANCES" count={visiblePlugins.length} />
          {visiblePlugins.length > 0 ? (
            <div className={studioCss.pluginTableWrap}>
              <table className={studioCss.pluginTable}>
                <thead><tr><th>插件</th><th>类别</th><th>状态</th><th>位置</th></tr></thead>
                <tbody>
                  {visiblePlugins.map((plugin) => {
                    const location = resolvePluginLocation(plugin, analysis);
                    return (
                      <tr key={plugin.id} data-selected={isSelected(currentTarget, "plugin", plugin.id)}>
                        <th scope="row">{plugin.name}</th>
                        <td><span className={studioCss.sourceBadge} data-kind={pluginKind(plugin)}>{plugin.kind.trim() || "未分类"}</span></td>
                        <td><span className={studioCss.stateBadge} data-supported={plugin.stateSupported}>{plugin.stateSupported ? "状态可读" : "状态不支持"}</span></td>
                        <td>
                          <button
                            type="button"
                            className={studioCss.locationButton}
                            onClick={() => selectTarget(location ?? { type: "plugin", id: plugin.id })}
                            title={location ? `选择 ${locationLabel(location, analysis)}` : "快照未提供可解析的位置映射，选择插件实例"}
                          >{plugin.location || "位置未知"}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <EmptyCopy>{analysis.plugins.length > 0 ? "当前来源筛选下没有插件。" : "快照没有报告插件实例。"}</EmptyCopy>}
        </section>
      </section>

      <section className={studioCss.mixerSection} aria-labelledby="mixer-heading">
        <div className={studioCss.mixerHeading}>
          <div><p className={studioCss.panelKicker}>MIXER MAP</p><h2 id="mixer-heading">效果链与路由</h2></div>
          <span>{activeInserts.length} / {analysis.mixerInserts.length} 个有效 Insert</span>
        </div>
        {activeInserts.length > 0 ? (
          <>
            <MixerRouteGraph inserts={activeInserts} knownInsertIds={new Set(analysis.mixerInserts.map((insert) => insert.id))} onSelect={selectTarget} selectedTarget={currentTarget} />
            <div className={studioCss.effectChains} aria-label="Mixer 效果链">
              {activeInserts.map((insert) => (
                <EffectChain key={insert.id} insert={insert} plugins={analysis.plugins} selected={isSelected(currentTarget, "mixer_insert", insert.id)} onSelect={selectTarget} />
              ))}
            </div>
          </>
        ) : <EmptyCopy>没有带插件或路由的 Mixer Insert；空 Insert 已折叠。</EmptyCopy>}
      </section>

      <AutomationSection analysis={analysis} automations={analysis.automations} onSelect={selectTarget} />
    </article>
  );
}

function PanelHeader({ id, label, count }: { id: string; label: string; count: number }) {
  return <header className={studioCss.signalPanelHeader}><h2 id={id}>{label}</h2><span>{count}</span></header>;
}

function EmptyCopy({ children }: { children: React.ReactNode }) {
  return <p className={studioCss.signalEmpty}>{children}</p>;
}

function EffectChain({ insert, plugins, selected, onSelect }: {
  insert: StudioMixerInsertSummary;
  plugins: StudioPluginInstance[];
  selected: boolean;
  onSelect: (target: PluginMixerTarget) => void;
}) {
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return (
    <section data-selected={selected}>
      <button type="button" onClick={() => onSelect({ type: "mixer_insert", id: insert.id })}>{insert.name}</button>
      <ol>
        {insert.slotPluginIds.length > 0 ? insert.slotPluginIds.map((id, index) => {
          const plugin = pluginsById.get(id);
          return <li key={`${id}-${index}`} data-resolved={Boolean(plugin)}><span>{index + 1}</span><strong>{plugin?.name ?? id}</strong><small>{plugin ? "已关联" : "插件 ID 未解析"}</small></li>;
        }) : <li data-empty="true">无效果插件</li>}
      </ol>
    </section>
  );
}

function MixerRouteGraph({ inserts, knownInsertIds, selectedTarget, onSelect }: {
  inserts: StudioMixerInsertSummary[];
  knownInsertIds: Set<string>;
  selectedTarget: PluginMixerTarget | null;
  onSelect: (target: PluginMixerTarget) => void;
}) {
  const shownNodes = inserts.slice(0, MAX_ROUTE_NODES);
  const shownIds = new Set(shownNodes.map((insert) => insert.id));
  const allEdges = inserts.flatMap((insert) => insert.routeTargetIds.map((targetId) => ({ sourceId: insert.id, targetId })));
  const shownEdges = allEdges.filter((edge) => shownIds.has(edge.sourceId) && shownIds.has(edge.targetId)).slice(0, MAX_ROUTE_EDGES);
  const unresolvedEdges = allEdges.filter((edge) => !knownInsertIds.has(edge.targetId));
  const columns = Math.min(4, Math.max(1, shownNodes.length));
  const rows = Math.ceil(shownNodes.length / columns);
  const width = 760;
  const height = Math.max(150, rows * 90 + 42);
  const positions = new Map(shownNodes.map((node, index) => [node.id, {
    x: 24 + (index % columns) * ((width - 48) / columns),
    y: 28 + Math.floor(index / columns) * 90
  }]));
  const summary = `${inserts.length} 个有效 Insert，${allEdges.length} 条路由；绘制 ${shownNodes.length} 个节点和 ${shownEdges.length} 条边`;

  return (
    <figure className={studioCss.routeFigure}>
      <figcaption><strong>Mixer 路由图</strong><span>{summary}</span></figcaption>
      <p className={studioCss.routeTextSummary}>{summary}。{unresolvedEdges.length > 0 ? `${unresolvedEdges.length} 条路由目标未解析。` : "所有已绘制目标均可解析。"}</p>
      <svg role="img" aria-label="Mixer 路由图" viewBox={`0 0 ${width} ${height}`} className={studioCss.routeGraph}>
        <g aria-hidden="true">
          {shownEdges.map((edge, index) => {
            const source = positions.get(edge.sourceId)!;
            const target = positions.get(edge.targetId)!;
            return <line key={`${edge.sourceId}-${edge.targetId}-${index}`} x1={source.x + 70} y1={source.y + 22} x2={target.x + 70} y2={target.y + 22} data-route-edge="true" />;
          })}
        </g>
        {shownNodes.map((insert) => {
          const point = positions.get(insert.id)!;
          const selected = isSelected(selectedTarget, "mixer_insert", insert.id);
          return (
            <g key={insert.id} role="button" tabIndex={0} aria-label={`选择 ${insert.name}`} data-route-node="true" data-selected={selected}
              onClick={() => onSelect({ type: "mixer_insert", id: insert.id })}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect({ type: "mixer_insert", id: insert.id }); }}>
              <rect x={point.x} y={point.y} width="140" height="44" rx="2" />
              <text x={point.x + 10} y={point.y + 19}>{shortLabel(insert.name)}</text>
              <text x={point.x + 10} y={point.y + 34}>{insert.slotPluginIds.length} FX · {insert.routeTargetIds.length} routes</text>
            </g>
          );
        })}
      </svg>
      {(shownNodes.length < inserts.length || shownEdges.length < allEdges.length) && <small className={studioCss.graphLimitNotice}>大型路由图已限量绘制；完整数量保留在文字摘要中。</small>}
      {unresolvedEdges.length > 0 && <ul className={studioCss.unresolvedRoutes} aria-label="未解析 Mixer 路由">{unresolvedEdges.slice(0, 20).map((edge, index) => <li key={`${edge.sourceId}-${edge.targetId}-${index}`}>{edge.sourceId} → {edge.targetId}</li>)}</ul>}
    </figure>
  );
}

function AutomationSection({ analysis, automations, onSelect }: {
  analysis: StudioAnalysis;
  automations: StudioAutomationSummary[];
  onSelect: (target: PluginMixerTarget) => void;
}) {
  return (
    <section className={studioCss.automationSection} aria-labelledby="automation-heading">
      <header><div><p className={studioCss.panelKicker}>CONTROL LINKS</p><h2 id="automation-heading">自动化目标</h2></div><span>{automations.length}</span></header>
      {automations.length > 0 ? <ul>{automations.map((automation) => {
        const target = resolveAutomationTarget(automation, analysis);
        return <li key={automation.id}>
          <div><strong>{automation.name}</strong><small>{automation.pointCount} 个点</small></div>
          {target ? <button type="button" onClick={() => onSelect(target)}>{automation.targetName} · 已解析</button> : <span>{automation.targetName || "目标未报告"} · 未解析</span>}
        </li>;
      })}</ul> : <EmptyCopy>快照没有报告自动化。</EmptyCopy>}
    </section>
  );
}

function pluginKind(plugin: StudioPluginInstance): Exclude<PluginKindFilter, "all"> {
  const kind = plugin.kind.trim().toLowerCase();
  if (kind === "generator") return "generator";
  if (kind === "effect") return "effect";
  return "unknown";
}

function kindFilterLabel(kind: PluginKindFilter): string {
  if (kind === "all") return "全部";
  if (kind === "generator") return "生成器";
  if (kind === "effect") return "效果器";
  return "未分类";
}

function resolveChannelPlugin(channel: StudioChannelSummary, plugins: StudioPluginInstance[]): StudioPluginInstance | null {
  const byId = plugins.filter((plugin) => plugin.id === channel.id);
  if (byId.length === 1) return byId[0];
  if (!channel.pluginName) return null;
  const name = normalize(channel.pluginName);
  const byName = plugins.filter((plugin) => normalize(plugin.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

function resolvePluginLocation(plugin: StudioPluginInstance, analysis: StudioAnalysis): PluginMixerTarget | null {
  const channelLocation = /^channel:([^:]+)$/.exec(plugin.location.trim());
  if (channelLocation) {
    const channels = analysis.channels.filter((channel) => channel.id === channelLocation[1]);
    return channels.length === 1 ? { type: "channel", id: channels[0].id } : null;
  }
  const mixerLocation = /^mixer:([^:]+):slot:(\d+)$/.exec(plugin.location.trim());
  if (!mixerLocation) return null;
  const inserts = analysis.mixerInserts.filter((insert) => insert.id === mixerLocation[1]);
  return inserts.length === 1 ? { type: "mixer_insert", id: inserts[0].id } : null;
}

function resolveAutomationTarget(automation: StudioAutomationSummary, analysis: StudioAnalysis): PluginMixerTarget | null {
  if (!automation.targetName) return null;
  const target = normalize(automation.targetName);
  const candidates: PluginMixerTarget[] = [];
  for (const channel of analysis.channels) if (normalize(channel.id) === target || normalize(channel.name) === target) candidates.push({ type: "channel", id: channel.id });
  for (const plugin of analysis.plugins) if (normalize(plugin.id) === target || normalize(plugin.name) === target) candidates.push({ type: "plugin", id: plugin.id });
  for (const insert of analysis.mixerInserts) if (normalize(insert.id) === target || normalize(insert.name) === target) candidates.push({ type: "mixer_insert", id: insert.id });
  return candidates.length === 1 ? candidates[0] : null;
}

function locationLabel(target: PluginMixerTarget, analysis: StudioAnalysis): string {
  if (target.type === "channel") return analysis.channels.find((item) => item.id === target.id)?.name ?? target.id;
  if (target.type === "mixer_insert") return analysis.mixerInserts.find((item) => item.id === target.id)?.name ?? target.id;
  return analysis.plugins.find((item) => item.id === target.id)?.name ?? target.id;
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase(); }
function shortLabel(value: string): string { return value.length > 20 ? `${value.slice(0, 19)}…` : value; }
function isSelected(target: PluginMixerTarget | null, type: PluginMixerTarget["type"], id: string): boolean { return target?.type === type && target.id === id; }
