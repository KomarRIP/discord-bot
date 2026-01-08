import { ulid } from "ulid";
import { AppError } from "../../shared/errors/appError.js";
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
                title: "Setup уже запущен",
                message: `Есть активная сессия: ${active.sessionId} (status=${active.status}, step=${active.stepKey}).`,
                data: { sessionId: active.sessionId },
            };
        }
        const answers = {
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
        const sessionId = ulid();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        this.storage.setupSessions.createSession({
            sessionId,
            guildId: ctx.guildId,
            status: "confirmed",
            stepKey: "mvp_default",
            answersJson: JSON.stringify(answers),
            expiresAt,
        });
        return {
            type: "success",
            title: "Setup подготовлен (MVP)",
            message: "Создал сессию с дефолтными ответами для шаблона SSO_RF. Дальше используйте `/deploy preview`, затем `/deploy apply`.",
            data: { sessionId },
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
            title: "Setup статус",
            message: `sessionId=${active.sessionId}, status=${active.status}, step=${active.stepKey}, expiresAt=${active.expiresAt}`,
            data: { sessionId: active.sessionId },
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
}
