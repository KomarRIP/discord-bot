import { ulid } from "ulid";
import { AppError } from "../../shared/errors/appError.js";
const STEP_ORDER = ["template", "unit_name", "unit_size", "intake_mode", "guest_policy", "preview"];
export class SetupWizardService {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async start(ctx) {
        if (!ctx.guildId) {
            return {
                type: "error",
                errorCode: "VALIDATION_FAILED",
                userMessage: "Команда доступна только на сервере (не в DM).",
                retryable: false,
            };
        }
        const active = this.storage.setupSessions.getActiveSession(ctx.guildId);
        if (active) {
            return {
                type: "success",
                title: "Setup wizard",
                message: `Продолжаем активную сессию: ${active.sessionId} (status=${active.status}, step=${active.stepKey}).`,
                data: { ui: { kind: "wizard", state: this.toStateDto(active) } },
            };
        }
        const sessionId = ulid();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const session = this.storage.setupSessions.createSession({
            sessionId,
            guildId: ctx.guildId,
            status: "active",
            stepKey: "template",
            answersJson: JSON.stringify(this.defaultAnswers()),
            expiresAt,
        });
        return {
            type: "success",
            title: "Setup wizard",
            message: "Мастер настройки запущен. Ответы сохраняются, можно возвращаться назад/вперёд.",
            data: { ui: { kind: "wizard", state: this.toStateDto(session) } },
        };
    }
    async status(ctx) {
        const active = this.storage.setupSessions.getActiveSession(ctx.guildId);
        if (!active) {
            return {
                type: "success",
                title: "Setup не запущен",
                message: "Активной setup-сессии нет. Запустите `/setup start`.",
            };
        }
        return {
            type: "success",
            title: "Setup wizard",
            message: `sessionId=${active.sessionId}, status=${active.status}, step=${active.stepKey}, expiresAt=${active.expiresAt}`,
            data: { sessionId: active.sessionId, ui: { kind: "wizard", state: this.toStateDto(active) } },
        };
    }
    async cancel(ctx) {
        const active = this.storage.setupSessions.getActiveSession(ctx.guildId);
        if (!active) {
            return {
                type: "success",
                title: "Нечего отменять",
                message: "Активной setup-сессии нет.",
            };
        }
        if (active.status === "deploying") {
            throw new AppError({
                code: "CONFLICT",
                message: "Setup в состоянии deploying: отмена запрещена",
            });
        }
        this.storage.setupSessions.updateSession(active.sessionId, { status: "cancelled" });
        return {
            type: "success",
            title: "Setup отменён",
            message: `Сессия ${active.sessionId} помечена как cancelled.`,
            data: { sessionId: active.sessionId },
        };
    }
    async navigate(ctx, input) {
        if (!ctx.guildId) {
            return { type: "error", errorCode: "VALIDATION_FAILED", userMessage: "guildId обязателен.", retryable: false };
        }
        const session = this.loadActiveSessionOrThrow(ctx.guildId, input.sessionId);
        if (session.status === "deploying")
            throw new AppError({ code: "CONFLICT", message: "Сессия уже в deploying." });
        const current = session.stepKey;
        const idx = Math.max(0, STEP_ORDER.indexOf(current));
        const nextIdx = input.dir === "back" ? Math.max(0, idx - 1) : Math.min(STEP_ORDER.length - 1, idx + 1);
        const nextStep = STEP_ORDER[nextIdx];
        const answers = this.safeParseAnswers(session.answersJson);
        if (input.dir === "next")
            this.validateStepOrThrow(current, answers);
        const updated = this.storage.setupSessions.updateSession(session.sessionId, { stepKey: nextStep });
        return {
            type: "success",
            title: "Setup wizard",
            message: `Шаг: ${nextStep}`,
            data: { ui: { kind: "wizard", state: this.toStateDto(updated) } },
        };
    }
    async updateAnswersFromModal(ctx, input) {
        if (!ctx.guildId) {
            return { type: "error", errorCode: "VALIDATION_FAILED", userMessage: "guildId обязателен.", retryable: false };
        }
        const session = this.loadActiveSessionOrThrow(ctx.guildId, input.sessionId);
        if (session.status === "deploying")
            throw new AppError({ code: "CONFLICT", message: "Сессия уже в deploying." });
        const answers = this.safeParseAnswers(session.answersJson);
        if (input.field === "unit_name") {
            const name = (input.unitName ?? "").trim();
            if (name.length < 2 || name.length > 50) {
                return {
                    type: "error",
                    errorCode: "VALIDATION_FAILED",
                    userMessage: "Имя подразделения должно быть длиной 2..50 символов.",
                    retryable: false,
                };
            }
            answers.unit.name = name;
        }
        if (input.field === "unit_size") {
            const size = Number(input.unitSize);
            const limit = Number(input.positionsLimitPerMember);
            if (!Number.isFinite(size) || size < 5 || size > 100) {
                return {
                    type: "error",
                    errorCode: "VALIDATION_FAILED",
                    userMessage: "Размер подразделения должен быть числом 5..100.",
                    retryable: false,
                };
            }
            if (!Number.isFinite(limit) || limit < 1 || limit > 5) {
                return {
                    type: "error",
                    errorCode: "VALIDATION_FAILED",
                    userMessage: "Лимит должностей на участника должен быть числом 1..5.",
                    retryable: false,
                };
            }
            answers.unit.size = Math.trunc(size);
            answers.unit.positionsLimitPerMember = Math.trunc(limit);
        }
        const updated = this.storage.setupSessions.updateSession(session.sessionId, { answersJson: JSON.stringify(answers) });
        return {
            type: "success",
            title: "Setup wizard",
            message: "Сохранено.",
            data: { ui: { kind: "wizard", state: this.toStateDto(updated) } },
        };
    }
    markDeploying(guildId, sessionId) {
        const session = this.loadActiveSessionOrThrow(guildId, sessionId);
        this.storage.setupSessions.updateSession(session.sessionId, { status: "deploying" });
    }
    markCompleted(guildId, sessionId) {
        const session = this.loadActiveSessionOrThrow(guildId, sessionId);
        this.storage.setupSessions.updateSession(session.sessionId, { status: "completed" });
    }
    markFailed(guildId, sessionId) {
        const session = this.loadActiveSessionOrThrow(guildId, sessionId);
        this.storage.setupSessions.updateSession(session.sessionId, { status: "failed" });
    }
    defaultAnswers() {
        return {
            templateId: "SSO_RF",
            unit: {
                name: "Отряд",
                size: 18,
                positionsLimitPerMember: 2,
                intakeMode: "gated",
                discipline: { warningsBeforeEscalation: 3 },
            },
            security: {
                require2FAForStaff: false,
                logChannelKey: "CH_AUDIT",
            },
        };
    }
    toStateDto(session) {
        const answers = this.safeParseAnswers(session.answersJson);
        const stepKey = (STEP_ORDER.includes(session.stepKey) ? session.stepKey : "template");
        return {
            sessionId: session.sessionId,
            guildId: session.guildId,
            status: session.status,
            stepKey,
            answers,
            expiresAt: session.expiresAt,
        };
    }
    safeParseAnswers(raw) {
        try {
            const parsed = JSON.parse(raw);
            const base = this.defaultAnswers();
            return {
                templateId: parsed.templateId ?? base.templateId,
                unit: {
                    name: parsed.unit?.name ?? base.unit.name,
                    size: parsed.unit?.size ?? base.unit.size,
                    positionsLimitPerMember: parsed.unit?.positionsLimitPerMember ?? base.unit.positionsLimitPerMember,
                    intakeMode: "gated",
                    discipline: { warningsBeforeEscalation: parsed.unit?.discipline?.warningsBeforeEscalation ?? base.unit.discipline.warningsBeforeEscalation },
                },
                security: {
                    require2FAForStaff: parsed.security?.require2FAForStaff ?? base.security.require2FAForStaff,
                    logChannelKey: parsed.security?.logChannelKey ?? base.security.logChannelKey,
                },
            };
        }
        catch {
            return this.defaultAnswers();
        }
    }
    validateStepOrThrow(stepKey, answers) {
        if (stepKey === "template") {
            if (!answers.templateId)
                throw new AppError({ code: "VALIDATION_FAILED", message: "Не выбран шаблон.", retryable: false });
            return;
        }
        if (stepKey === "unit_name") {
            const name = (answers.unit.name ?? "").trim();
            if (name.length < 2 || name.length > 50) {
                throw new AppError({ code: "VALIDATION_FAILED", message: "Имя подразделения должно быть длиной 2..50 символов.", retryable: false });
            }
            return;
        }
        if (stepKey === "unit_size") {
            const size = answers.unit.size;
            const limit = answers.unit.positionsLimitPerMember;
            if (!Number.isFinite(size) || size < 5 || size > 100) {
                throw new AppError({ code: "VALIDATION_FAILED", message: "Размер подразделения должен быть числом 5..100.", retryable: false });
            }
            if (!Number.isFinite(limit) || limit < 1 || limit > 5) {
                throw new AppError({ code: "VALIDATION_FAILED", message: "Лимит должностей на участника должен быть числом 1..5.", retryable: false });
            }
            return;
        }
    }
    loadActiveSessionOrThrow(guildId, sessionId) {
        const active = this.storage.setupSessions.getActiveSession(guildId);
        if (!active)
            throw new AppError({ code: "NOT_FOUND", message: "Активная setup-сессия не найдена.", retryable: false });
        if (active.sessionId !== sessionId) {
            throw new AppError({ code: "CONFLICT", message: "Состояние мастера изменилось. Запросите /setup status и повторите.", retryable: false });
        }
        if (new Date(active.expiresAt).getTime() <= Date.now() && (active.status === "active" || active.status === "confirmed")) {
            this.storage.setupSessions.updateSession(active.sessionId, { status: "cancelled" });
            throw new AppError({ code: "NOT_FOUND", message: "Setup-сессия истекла. Запустите /setup start заново.", retryable: false });
        }
        return active;
    }
}
