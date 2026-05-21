"use strict";
/**
 * add-credits.ts
 *
 * Usage:
 *   pnpm tsx scripts/add-credits.ts <email> <credits>
 *
 * Example:
 *   pnpm tsx scripts/add-credits.ts user@example.com 100
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var client_1 = require("@prisma/client");
var library_1 = require("@prisma/client/runtime/library");
var prisma = new client_1.PrismaClient();
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, emailArg, creditsArg, email, creditsToAdd, user, result;
        var _this = this;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _a = process.argv, emailArg = _a[2], creditsArg = _a[3];
                    if (!emailArg || !creditsArg) {
                        console.error("Usage: pnpm tsx scripts/add-credits.ts <email> <credits>");
                        process.exit(1);
                    }
                    email = emailArg.trim().toLowerCase();
                    creditsToAdd = parseFloat(creditsArg);
                    if (isNaN(creditsToAdd) || creditsToAdd <= 0) {
                        console.error("Error: credits must be a positive number.");
                        process.exit(1);
                    }
                    return [4 /*yield*/, prisma.user.findUnique({ where: { email: email } })];
                case 1:
                    user = _c.sent();
                    if (!user) {
                        console.error("Error: no user found with email \"".concat(email, "\"."));
                        process.exit(1);
                    }
                    console.log("Found user: ".concat((_b = user.name) !== null && _b !== void 0 ? _b : user.email, " (id: ").concat(user.id, ")"));
                    return [4 /*yield*/, prisma.$transaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                            var balance, balanceBefore, amount, balanceAfter, updated, ledger;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, tx.userCreditBalance.upsert({
                                            where: { userId: user.id },
                                            create: {
                                                userId: user.id,
                                                purchasedCredits: 0,
                                                earnedCredits: 0,
                                                heldCredits: 0,
                                                totalAvailable: 0,
                                            },
                                            update: {},
                                        })];
                                    case 1:
                                        balance = _a.sent();
                                        balanceBefore = new library_1.Decimal(balance.totalAvailable.toString());
                                        amount = new library_1.Decimal(creditsToAdd.toString());
                                        balanceAfter = balanceBefore.add(amount);
                                        return [4 /*yield*/, tx.userCreditBalance.update({
                                                where: { userId: user.id },
                                                data: {
                                                    earnedCredits: { increment: amount },
                                                    totalAvailable: { increment: amount },
                                                },
                                            })];
                                    case 2:
                                        updated = _a.sent();
                                        return [4 /*yield*/, tx.creditLedger.create({
                                                data: {
                                                    userId: user.id,
                                                    type: client_1.LedgerType.EARN,
                                                    amount: amount,
                                                    balanceBefore: balanceBefore,
                                                    balanceAfter: balanceAfter,
                                                    reason: "Manual credit grant via add-credits script",
                                                },
                                            })];
                                    case 3:
                                        ledger = _a.sent();
                                        return [2 /*return*/, { updated: updated, ledger: ledger }];
                                }
                            });
                        }); })];
                case 2:
                    result = _c.sent();
                    console.log("\nCredits added successfully!");
                    console.log("  Added        : ".concat(creditsToAdd));
                    console.log("  New balance  : ".concat(result.updated.totalAvailable.toString()));
                    console.log("  Ledger entry : ".concat(result.ledger.id));
                    return [2 /*return*/];
            }
        });
    });
}
main()
    .catch(function (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
})
    .finally(function () { return prisma.$disconnect(); });
