"use client";

import { useMemo } from "react";
import {
    ArrowUpRight,
    Check,
    CircleAlert,
    Clock3,
    LocateFixed,
    Pause,
    Radio,
    RotateCcw
} from "lucide-react";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type {
    AgentEvent,
    AgentProvider,
    AgentThread,
    ThreadStatus
} from "@/lib/types";
import styles from "./NowView.module.css";

export interface NowViewProps {
    /** Selects a thread in the inspector while keeping the Now view mounted. */
    onOpen?: (threadId: string) => void;
    /** Moves the main canvas to the exact thread, typically switching to constellation view. */
    onLocate?: (threadId: string) => void;
}

const providerMeta: Record<
    AgentProvider,
    { label: string; short: string; color: string }
> = {
    codex: { label: "Codex", short: "C", color: "#7aa7b8" },
    claude: { label: "Claude Code", short: "CC", color: "#d97757" }
};
const statusLabels: Record<ThreadStatus, string> = {
    running: "Running",
    waiting: "Waiting",
    needs_attention: "Needs you",
    completed: "Completed",
    failed: "Failed",
    idle: "Idle"
};

function providerFor(thread: AgentThread): AgentProvider {
    return (
        thread.provider ??
        (thread.id.startsWith("claude:") ? "claude" : "codex")
    );
}

function timestampFor(thread: AgentThread, latestEventTimestamp?: string) {
    const candidates = [
        thread.updatedAt,
        latestEventTimestamp,
        thread.finishedAt,
        thread.startedAt
    ];
    const valid = candidates
        .map((value) => ({ value, time: value ? Date.parse(value) : NaN }))
        .filter((item) => Number.isFinite(item.time));
    return (
        valid.sort((a, b) => b.time - a.time)[0] ?? {
            value: undefined,
            time: 0
        }
    );
}

function compactRelative(time: number) {
    const delta = Math.max(0, Date.now() - time);
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 7
        ? `${days}d ago`
        : new Date(time).toLocaleDateString([], {
              month: "short",
              day: "numeric"
          });
}

function StatusGlyph({ status }: { status: ThreadStatus }) {
    if (status === "running") return <Radio aria-hidden="true" />;
    if (status === "waiting") return <Pause aria-hidden="true" />;
    if (status === "completed") return <Check aria-hidden="true" />;
    if (status === "failed" || status === "needs_attention")
        return <CircleAlert aria-hidden="true" />;
    return <Clock3 aria-hidden="true" />;
}

type Activity = { thread: AgentThread; last: { value?: string; time: number } };
type ProjectGroup = {
    folderId: string;
    activities: Activity[];
    latest: number;
};

export function NowView({ onLocate, onOpen }: NowViewProps) {
    const folders = useConstellationStore((s) => s.folders);
    const threads = useConstellationStore((s) => s.threads);
    const events = useConstellationStore((s) => s.events);
    const selectedFolderId = useConstellationStore((s) => s.selectedFolderId);
    const selectedThreadId = useConstellationStore((s) => s.selectedThreadId);
    const query = useConstellationStore((s) => s.query);
    const selectThread = useConstellationStore((s) => s.selectThread);

    const activity = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const latestEvents: Record<
            string,
            { timestamp: string; time: number }
        > = {};
        Object.values(events).forEach((event) => {
            const time = Date.parse(event.timestamp);
            if (
                Number.isFinite(time) &&
                (!latestEvents[event.threadId] ||
                    time > latestEvents[event.threadId].time)
            ) {
                latestEvents[event.threadId] = {
                    timestamp: event.timestamp,
                    time
                };
            }
        });
        return Object.values(threads)
            .filter((thread) => {
                if (
                    thread.archived ||
                    (selectedFolderId && thread.folderId !== selectedFolderId)
                )
                    return false;
                const provider = providerMeta[providerFor(thread)];
                const folder = folders[thread.folderId];
                return (
                    !needle ||
                    `${thread.key} ${thread.title} ${thread.objective} ${thread.summary} ${thread.branch ?? ""} ${provider.label} ${statusLabels[thread.status]} ${folder?.name ?? ""} ${folder?.path ?? ""}`
                        .toLowerCase()
                        .includes(needle)
                );
            })
            .map((thread) => ({
                thread,
                last: timestampFor(thread, latestEvents[thread.id]?.timestamp)
            }))
            .sort((a, b) => b.last.time - a.last.time);
    }, [events, folders, query, selectedFolderId, threads]);

    const running = activity.filter(
        ({ thread }) => thread.status === "running"
    );
    const recent = activity
        .filter(({ thread }) => thread.status !== "running")
        .slice(0, 16);

    const grouped = (items: Activity[]) => {
        const byFolder = new Map<string, Activity[]>();
        items.forEach((item) =>
            byFolder.set(item.thread.folderId, [
                ...(byFolder.get(item.thread.folderId) ?? []),
                item
            ])
        );
        return [...byFolder.entries()]
            .map(([folderId, group]) => ({
                folderId,
                activities: group,
                latest: group[0]?.last.time ?? 0
            }))
            .sort((a, b) => b.latest - a.latest) as ProjectGroup[];
    };

    const openThread = (id: string) => (onOpen ? onOpen(id) : selectThread(id));
    const renderGroups = (items: Activity[], section: string) =>
        grouped(items).map((project) => {
            const folder = folders[project.folderId];
            const providers = (["codex", "claude"] as AgentProvider[])
                .map((provider) => ({
                    provider,
                    items: project.activities.filter(
                        ({ thread }) => providerFor(thread) === provider
                    )
                }))
                .filter(({ items: providerItems }) => providerItems.length);
            return (
                <section
                    className={styles.project}
                    key={`${section}-${project.folderId}`}
                    aria-labelledby={`${section}-${project.folderId}`}
                >
                    <div className={styles.projectHeader}>
                        <span
                            className={styles.projectMark}
                            style={{ backgroundColor: folder?.accent }}
                            aria-hidden="true"
                        />
                        <h4 id={`${section}-${project.folderId}`}>
                            {folder?.name ?? "Unknown project"}
                        </h4>
                        <span className={styles.projectCount}>
                            {project.activities.length}{" "}
                            {project.activities.length === 1
                                ? "agent"
                                : "agents"}
                        </span>
                    </div>
                    {providers.map(({ provider, items: providerItems }) => (
                        <div className={styles.providerGroup} key={provider}>
                            <h5>
                                <span
                                    className={styles.providerBadge}
                                    style={{
                                        borderColor:
                                            providerMeta[provider].color,
                                        color: providerMeta[provider].color
                                    }}
                                >
                                    {providerMeta[provider].short}
                                </span>
                                {providerMeta[provider].label}
                                <span className={styles.providerCount}>
                                    {providerItems.length}
                                </span>
                            </h5>
                            <div className={styles.cards}>
                                {providerItems.map(({ thread, last }) => {
                                    const parent = thread.parentId
                                        ? threads[thread.parentId]
                                        : undefined;
                                    const meta = providerMeta[provider];
                                    return (
                                        <article
                                            className={`${styles.card} ${selectedThreadId === thread.id ? styles.selected : ""}`}
                                            key={thread.id}
                                            style={
                                                {
                                                    "--provider": meta.color
                                                } as React.CSSProperties
                                            }
                                        >
                                            <button
                                                className={styles.cardMain}
                                                onClick={() =>
                                                    openThread(thread.id)
                                                }
                                                aria-label={`Open ${thread.title}, ${meta.label}, ${statusLabels[thread.status]}`}
                                            >
                                                <span
                                                    className={`${styles.status} ${styles[`status_${thread.status}`]}`}
                                                >
                                                    <StatusGlyph
                                                        status={thread.status}
                                                    />
                                                    <span>
                                                        {
                                                            statusLabels[
                                                                thread.status
                                                            ]
                                                        }
                                                    </span>
                                                    {Boolean(
                                                        thread.recentlyActiveExternally &&
                                                        thread.status !==
                                                            "running" &&
                                                        thread.status !==
                                                            "needs_attention"
                                                    ) && (
                                                        <span
                                                            className={
                                                                styles.externalBadge
                                                            }
                                                        >
                                                            Recent external
                                                        </span>
                                                    )}
                                                </span>
                                                <span
                                                    className={styles.cardBody}
                                                >
                                                    <strong>
                                                        {thread.title}
                                                    </strong>
                                                    <span
                                                        className={
                                                            styles.summary
                                                        }
                                                    >
                                                        {thread.summary ||
                                                            thread.objective}
                                                    </span>
                                                    <span
                                                        className={
                                                            styles.context
                                                        }
                                                    >
                                                        {parent ? (
                                                            <>
                                                                <RotateCcw aria-hidden="true" />{" "}
                                                                Subagent of{" "}
                                                                {parent.title}
                                                            </>
                                                        ) : (
                                                            <>
                                                                <ArrowUpRight aria-hidden="true" />{" "}
                                                                Root agent
                                                            </>
                                                        )}
                                                    </span>
                                                </span>
                                                <time
                                                    className={styles.time}
                                                    dateTime={last.value}
                                                >
                                                    {last.time
                                                        ? compactRelative(
                                                              last.time
                                                          )
                                                        : "time unknown"}
                                                </time>
                                            </button>
                                            <button
                                                className={styles.locate}
                                                onClick={() =>
                                                    onLocate?.(thread.id)
                                                }
                                                disabled={!onLocate}
                                                aria-label={`Show ${thread.title} in constellation`}
                                            >
                                                <LocateFixed aria-hidden="true" />
                                                <span>
                                                    Show in constellation
                                                </span>
                                            </button>
                                        </article>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </section>
            );
        });

    return (
        <section className={styles.view} aria-labelledby="now-heading">
            <header className={styles.heading}>
                <div>
                    <p className={styles.kicker}>Operations / live pulse</p>
                    <h2 id="now-heading">Now</h2>
                    <p className={styles.subtle}>
                        Running agents and the sessions most ready to resume,
                        grouped by project.
                    </p>
                </div>
                <div className={styles.totals}>
                    <strong>{running.length}</strong>
                    <span>running now</span>
                </div>
            </header>
            <section
                className={styles.section}
                aria-labelledby="running-heading"
            >
                <div className={styles.sectionHead}>
                    <div>
                        <h3 id="running-heading">
                            <span
                                className={styles.liveDot}
                                aria-hidden="true"
                            />
                            Running now
                        </h3>
                        <p>Live work across every connected provider.</p>
                    </div>
                    <span>{running.length}</span>
                </div>
                {running.length ? (
                    renderGroups(running, "running")
                ) : (
                    <div className={styles.empty}>
                        <Radio aria-hidden="true" />
                        <p>
                            <strong>No agents are running right now.</strong>
                            <span>
                                Start an agent from a project, or check Recently
                                active to resume the latest work.
                            </span>
                        </p>
                    </div>
                )}
            </section>
            <section
                className={styles.section}
                aria-labelledby="recent-heading"
            >
                <div className={styles.sectionHead}>
                    <div>
                        <h3 id="recent-heading">Recently active</h3>
                        <p>
                            The latest 16 non-running agents, ordered by
                            activity.
                        </p>
                    </div>
                    <span>{recent.length}</span>
                </div>
                {recent.length ? (
                    renderGroups(recent, "recent")
                ) : (
                    <div className={styles.empty}>
                        <Clock3 aria-hidden="true" />
                        <p>
                            <strong>No recent agents match this view.</strong>
                            <span>
                                Try clearing the search or project filter.
                            </span>
                        </p>
                    </div>
                )}
            </section>
        </section>
    );
}
