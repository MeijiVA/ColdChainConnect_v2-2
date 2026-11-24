import "dotenv/config";
import express from "express";
import cors from "cors";
import { handleDemo } from "./routes/demo";
import { uploadMiddleware, handleUpload } from "./routes/upload";
import {
  handleLogin,
  handleMfaSetup,
  handleMfaVerify,
  handleLogout,
  handleRefresh,
  updateUserPassword,
  resetUserMfa,
} from "./routes/auth";
import { handleDemoLogin } from "./routes/demo-login";
import { handleCreateAccount, handleListManagedAccounts, handleUpdateStaffPermissions, handleUpdateMfaRequirement, handleUpdateArchiveStatus } from "./routes/users";
import {
  listCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "./routes/customers";
import { importCustomers, importProducts, importInventory } from "./routes/excel-imports";
import {
  listProducts,
  createProduct,
  updateProduct,
  setProductArchived,
  listProductCosts,
} from "./routes/products";
import {
  listBatches,
  listBatchReservations,
  createBatch,
  updateBatch,
  deleteBatch,
  deletePallet,
  deletePalletItem,
  archiveBatch,
} from "./routes/batches";
import {
  listDrivers,
  createDriver,
  updateDriver,
  setDriverArchived,
} from "./routes/drivers";
import { getDriverSchedule } from "./routes/driver-schedule";
import { getAgentSchedule } from "./routes/agent-schedule";
import {
  listAgents,
  createAgent,
  updateAgent,
  setAgentArchived,
} from "./routes/agents";
import {
  listTrucks,
  createTruck,
  updateTruck,
  deleteTruck,
} from "./routes/trucks";
import {
  listBookings,
  listAgentDistricts,
  createBooking,
  updateBookingStatus,
  updateBookingItems,
  updatePreparedDeliveryDate,
  deleteBooking,
} from "./routes/bookings";
import {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoiceStatus,
  updateInvoicePaymentStatus,
} from "./routes/invoices";
import {
  listDeliveries,
  createDelivery,
  updateDeliveryStatus,
  updateDeliveryItemStatus,
  assignDelivery,
  removeDeliveryItem,
} from "./routes/deliveries";
import { listReceipts, confirmDeliveryItem, recordDeliveryItemPayment } from "./routes/receipts";
import { listAuditLogs } from "./routes/audit";
import { downloadBackup } from "./routes/backup";
import {
  listAccountsReceivable,
  getCustomerBalance,
  updateARStatus,
  updateARNotes,
} from "./routes/accounts-receivable";
import {
  listAgentReturns,
  createAgentReturn,
  acceptAgentReturn,
  rejectAgentReturn,
} from "./routes/agent-returns";
import {
  listInventoryBatches,
  getInventoryBatch,
  createInventoryBatch,
  updateInventoryBatch,
  deleteInventoryBatch,
  addInventoryBatchItem,
  removeInventoryBatchItem,
} from "./routes/inventory-batches";
import {
  listPallets,
  getPallet,
  createPallet,
  updatePalletStatus,
  approvePallet,
  deletePalletForOrder,
  getProductInventory,
  getProductStock,
  suggestBatches,
} from "./routes/pallets";
import { getSalesForecast } from "./routes/forecast";
import { getDashboardSummary } from "./routes/dashboard";
import { getUnseenCounts } from "./routes/unseen";
import { postSalesForecastChat } from "./routes/sales-forecast-chat";
import { getCustomerReport, getProfitReport, getSalesReport, getStockReport } from "./routes/reports";
import { authMiddleware, requireRole } from "./middleware/auth";
import { requireAnyPermission, requirePermission, staffModuleGuard } from "./middleware/permissions";
import { getPaymentReceipt, listPaymentAgents, listUnverifiedPayments, verifyReceiptPayment } from "./routes/payment-verification";
import { createCashRemittance, listCashCollections, listMyUnconfirmedPayments } from "./routes/cash-remittances";
import { approveExpense, createExpense, listExpenses, payExpense, rejectExpense } from "./routes/expenses";

export function createServer() {
  const app = express();

  // Behind Netlify/AWS Lambda (or any reverse proxy) the client IP is in X-Forwarded-For.
  // Trust exactly one hop there so req.ip is the real client; set TRUST_PROXY to override.
  const trustProxy = process.env.TRUST_PROXY ?? (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL ? "1" : "");
  if (trustProxy) app.set("trust proxy", /^[0-9]+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  // Middleware
  // Same-origin by default; list extra allowed origins in CORS_ORIGIN (comma-separated).
  const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean) ?? [];
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
  app.use(express.json({ limit: "6mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static("public"));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Example API routes
  app.get("/api/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  app.get("/api/demo", handleDemo);

  // Upload route
  app.post("/api/upload", authMiddleware, requireRole("admin"), uploadMiddleware, handleUpload);

  // Auth routes (no auth required)
  app.post("/api/auth/login", handleLogin);
  app.post("/api/auth/demo-login", handleDemoLogin); // 404 unless DEMO_ROLE_PICKER=true
  app.post("/api/auth/mfa/setup", handleMfaSetup);
  app.post("/api/auth/mfa/verify", handleMfaVerify);
  app.post("/api/auth/logout", handleLogout);
  app.post("/api/auth/refresh", authMiddleware, handleRefresh);
  app.get("/api/users", authMiddleware, requireRole("admin", "staff"), handleListManagedAccounts);
  app.patch("/api/users/:userId/module-permissions", authMiddleware, requireRole("admin"), handleUpdateStaffPermissions);
  app.patch("/api/users/:userId/mfa-required", authMiddleware, requireRole("admin"), handleUpdateMfaRequirement);
  app.patch("/api/users/:userId/archive", authMiddleware, requireRole("admin"), handleUpdateArchiveStatus);
  app.post("/api/users", authMiddleware, requireRole("admin"), handleCreateAccount);
  app.patch("/api/users/:userId/password", authMiddleware, requireRole("admin"), updateUserPassword);
  app.post("/api/users/:userId/mfa/reset", authMiddleware, requireRole("admin"), resetUserMfa);

  // Sidebar "new" badges: registered ahead of the staff module guard because it filters per module itself.
  app.get("/api/unseen", authMiddleware, requireRole("admin", "staff"), getUnseenCounts);

  app.use("/api", authMiddleware, staffModuleGuard);

  // Customers routes
  app.get("/api/customers", authMiddleware, listCustomers);
  app.post("/api/customers", authMiddleware, requireRole("admin"), createCustomer);
  app.patch("/api/customers/:id", authMiddleware, requireRole("admin"), updateCustomer);
  app.delete("/api/customers/:id", authMiddleware, requireRole("admin"), deleteCustomer);
  app.post("/api/customers/import", authMiddleware, requireRole("admin"), importCustomers);

  // Products routes
  app.get("/api/products", authMiddleware, listProducts);
  app.get("/api/product-costs", authMiddleware, requireRole("admin"), listProductCosts);
  app.post("/api/products", authMiddleware, requireRole("admin"), createProduct);
  app.patch("/api/products/:id", authMiddleware, requireRole("admin"), updateProduct);
  app.patch("/api/products/:id/archive", authMiddleware, requireRole("admin"), setProductArchived);
  app.post("/api/products/import", authMiddleware, requireRole("admin"), importProducts);

  // Batches routes
  app.get("/api/batches", authMiddleware, listBatches);
  app.get("/api/batches/reservations", authMiddleware, requireRole("admin"), listBatchReservations);
  app.post("/api/batches/import", authMiddleware, requireRole("admin"), importInventory);
  app.post("/api/batches", authMiddleware, requireRole("admin"), createBatch);
  app.patch("/api/batches/:id", authMiddleware, requireRole("admin"), updateBatch);
  app.patch("/api/batches/:id/archive", authMiddleware, requireRole("admin"), archiveBatch);
  app.delete("/api/batches/:id", authMiddleware, requireRole("admin"), deleteBatch);
  app.delete("/api/batches/pallets/:id", authMiddleware, requireRole("admin"), deletePallet);
  app.delete("/api/batches/pallet-items/:id", authMiddleware, requireRole("admin"), deletePalletItem);

  // Drivers routes
  app.get("/api/drivers", authMiddleware, listDrivers);
  app.post("/api/drivers", authMiddleware, requireRole("admin"), createDriver);
  app.patch("/api/drivers/:id", authMiddleware, requireRole("admin"), updateDriver);
  app.patch("/api/drivers/:id/archive", authMiddleware, requireRole("admin"), setDriverArchived);
  app.get("/api/driver-schedule", authMiddleware, requireRole("admin", "driver"), getDriverSchedule);
  app.get("/api/agent-schedule", authMiddleware, requireRole("agent"), getAgentSchedule);

  // Agents routes
  app.get("/api/agents", authMiddleware, listAgents);
  app.post("/api/agents", authMiddleware, requireRole("admin"), createAgent);
  app.patch("/api/agents/:id", authMiddleware, requireRole("admin"), updateAgent);
  app.patch("/api/agents/:id/archive", authMiddleware, requireRole("admin"), setAgentArchived);

  // Trucks routes
  app.get("/api/trucks", authMiddleware, listTrucks);
  app.post("/api/trucks", authMiddleware, requireRole("admin"), createTruck);
  app.patch("/api/trucks/:id", authMiddleware, requireRole("admin"), updateTruck);
  app.delete("/api/trucks/:id", authMiddleware, requireRole("admin"), deleteTruck);

  // Bookings routes
  app.get("/api/bookings", authMiddleware, listBookings);
  app.get("/api/agent-districts", authMiddleware, requireRole("agent"), listAgentDistricts);
  app.post("/api/bookings", authMiddleware, createBooking);
  app.patch("/api/bookings/:id/status", authMiddleware, requireRole("admin"), updateBookingStatus);
  app.patch("/api/bookings/:id/items", authMiddleware, requireRole("admin"), updateBookingItems);
  app.patch("/api/bookings/:id/prepared-delivery-date", authMiddleware, requireRole("admin"), updatePreparedDeliveryDate);
  app.delete("/api/bookings/:id", authMiddleware, deleteBooking);

  // Invoices routes
  app.get("/api/invoices", authMiddleware, listInvoices);
  app.get("/api/invoices/:id", authMiddleware, getInvoice);
  app.post("/api/invoices", authMiddleware, requireRole("admin"), createInvoice);
  app.patch("/api/invoices/:id/status", authMiddleware, requireRole("admin"), updateInvoiceStatus);
  app.patch("/api/invoices/:id/payment-status", authMiddleware, requireRole("admin"), updateInvoicePaymentStatus);

  // Dashboard summary (admin, and staff with the dashboard module)
  app.get("/api/dashboard/summary", authMiddleware, requireRole("admin", "staff"), getDashboardSummary);

  // Sales forecast routes
  app.get("/api/sales/forecast", authMiddleware, getSalesForecast);
  app.post("/api/sales/forecast/chat", authMiddleware, requireRole("admin"), postSalesForecastChat);

  // Reports routes
  app.get("/api/reports/sales", authMiddleware, requireRole("admin", "staff"), getSalesReport);
  app.get("/api/reports/stock", authMiddleware, requireRole("admin", "staff"), getStockReport);
  app.get("/api/reports/profit", authMiddleware, requireRole("admin", "staff"), getProfitReport);
  app.get("/api/reports/customers", authMiddleware, requireRole("admin", "staff"), getCustomerReport);

  // Deliveries routes
  app.get("/api/deliveries", authMiddleware, listDeliveries);
  app.post("/api/deliveries", authMiddleware, createDelivery);
  app.patch("/api/deliveries/:id/status", authMiddleware, requireRole("admin"), updateDeliveryStatus);
  app.patch("/api/deliveries/:id/assign", authMiddleware, assignDelivery);
  app.patch("/api/deliveries/:deliveryId/items/:itemId/status", authMiddleware, requireRole("admin"), updateDeliveryItemStatus);
  app.delete("/api/deliveries/:deliveryId/items/:itemId", authMiddleware, requireRole("admin"), removeDeliveryItem);

  // Receipts routes
  app.get("/api/receipts", authMiddleware, listReceipts);
  app.post("/api/deliveries/:id/items/:itemId/confirm", authMiddleware, requirePermission("delivery:confirm"), confirmDeliveryItem);
  app.post("/api/deliveries/:id/items/:itemId/payment", authMiddleware, requirePermission("delivery:confirm"), recordDeliveryItemPayment);

  // Payment verification (accounting)
  app.get("/api/payments/unverified", authMiddleware, requirePermission("payment:verify"), listUnverifiedPayments);
  app.get("/api/payments/agents", authMiddleware, requirePermission("payment:verify"), listPaymentAgents);
  app.get("/api/payments/:id/receipt", authMiddleware, requirePermission("payment:verify"), getPaymentReceipt);
  app.post("/api/payments/:id/verify", authMiddleware, requirePermission("payment:verify"), verifyReceiptPayment);
  app.get("/api/cash-remittances/collections", authMiddleware, requirePermission("cash:reconcile"), listCashCollections);
  app.post("/api/cash-remittances", authMiddleware, requirePermission("cash:reconcile"), createCashRemittance);
  app.get("/api/cash-remittances/mine", authMiddleware, requireRole("agent"), listMyUnconfirmedPayments);

  // Expenses: submit, approve or reject, pay
  app.get("/api/expenses", authMiddleware, requireAnyPermission("expense:submit", "expense:approve", "expense:pay", "maintenance:request"), listExpenses);
  app.post("/api/expenses", authMiddleware, requireAnyPermission("expense:submit", "maintenance:request"), createExpense);
  app.post("/api/expenses/:id/approve", authMiddleware, requirePermission("expense:approve"), approveExpense);
  app.post("/api/expenses/:id/reject", authMiddleware, requirePermission("expense:approve"), rejectExpense);
  app.post("/api/expenses/:id/pay", authMiddleware, requirePermission("expense:pay"), payExpense);

  // Audit logs routes
  app.get("/api/audit-logs", authMiddleware, requireRole("admin", "staff"), listAuditLogs);
  app.get("/api/backup", authMiddleware, requireRole("admin"), downloadBackup);

  // Accounts Receivable routes
  app.get("/api/accounts-receivable", authMiddleware, listAccountsReceivable);
  app.get("/api/accounts-receivable/customer/:customerId", authMiddleware, getCustomerBalance);
  app.patch("/api/accounts-receivable/:id/status", authMiddleware, requireRole("admin"), updateARStatus);
  app.patch("/api/accounts-receivable/:id/notes", authMiddleware, requireRole("admin"), updateARNotes);

  app.get("/api/agent-returns", authMiddleware, listAgentReturns);
  app.post("/api/agent-returns", authMiddleware, createAgentReturn);
  app.post("/api/agent-returns/:id/accept", authMiddleware, requireRole("admin"), acceptAgentReturn);
  app.post("/api/agent-returns/:id/reject", authMiddleware, requireRole("admin"), rejectAgentReturn);


  // Inventory Batch routes
  app.get("/api/inventory-batches", authMiddleware, listInventoryBatches);
  app.get("/api/inventory-batches/:id", authMiddleware, getInventoryBatch);
  app.post("/api/inventory-batches", authMiddleware, requireRole("admin"), createInventoryBatch);
  app.patch("/api/inventory-batches/:id", authMiddleware, requireRole("admin"), updateInventoryBatch);
  app.delete("/api/inventory-batches/:id", authMiddleware, requireRole("admin"), deleteInventoryBatch);
  app.post("/api/inventory-batches/:id/items", authMiddleware, requireRole("admin"), addInventoryBatchItem);
  app.delete("/api/inventory-batches/:id/items/:itemId", authMiddleware, requireRole("admin"), removeInventoryBatchItem);

  // Pallet routes (order preparation)
  app.get("/api/pallets", authMiddleware, listPallets);
  app.get("/api/pallets/:id", authMiddleware, getPallet);
  app.post("/api/pallets", authMiddleware, createPallet);
  app.patch("/api/pallets/:id/status", authMiddleware, requireRole("admin", "agent"), updatePalletStatus);
  app.patch("/api/pallets/:id/approve", authMiddleware, requireRole("admin", "agent"), approvePallet);
  app.delete("/api/pallets/:id", authMiddleware, requireRole("admin"), deletePalletForOrder);
  app.get("/api/products/inventory", authMiddleware, getProductInventory);
  app.get("/api/products/:productId/stock", authMiddleware, getProductStock);
  app.get("/api/orders/:orderId/suggested-batches", authMiddleware, suggestBatches);

  return app;
}
