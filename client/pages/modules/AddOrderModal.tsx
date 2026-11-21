import { NativeSelect } from "@/components/ui/native-select";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OrderProductList } from "./OrderProductList";
import { Product, Customer, Agent, Truck } from "@shared/api";

interface OrderItem {
  product_id: string;
  qty_ordered: number;
}

interface AddOrderModalProps {
  onClose: () => void;
  customers: Customer[];
  agents: Agent[];
  trucks: Truck[];
  products: Product[];
  productStock: Record<string, number>;
  orderItems: OrderItem[];
  newCustomerId: string;
  preparedDeliveryDate: string;
  onCustomerChange: (customerId: string) => void;
  onPreparedDeliveryDateChange: (date: string) => void;
  onAddItem: (productId: string) => void;
  onRemoveItem: (idx: number) => void;
  onItemChange: (idx: number, field: "product_id" | "qty_ordered", value: string | number) => void;
  onCreateOrder: () => void;
  isCreating: boolean;
}

export function AddOrderModal({
  onClose,
  customers,
  agents,
  trucks,
  products,
  productStock,
  orderItems,
  newCustomerId,
  preparedDeliveryDate,
  onCustomerChange,
  onPreparedDeliveryDateChange,
  onAddItem,
  onRemoveItem,
  onItemChange,
  onCreateOrder,
  isCreating,
}: AddOrderModalProps) {
  const today = new Date();
  const minDeliveryDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const getTotalQuantity = (): number => {
    return orderItems.reduce((sum, item) => sum + item.qty_ordered, 0);
  };

  const selectedCustomer = customers.find((c) => c.id === newCustomerId);
  const districtTruck = selectedCustomer?.district
    ? [...trucks]
        .filter((t) => t.district === selectedCustomer.district && agents.some((a) => a.id === t.agent_id && !a.is_archived))
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .sort((a, b) => Number(b.status === "available") - Number(a.status === "available"))[0]
    : undefined;
  const inheritedAgent = agents.find((a) => a.id === districtTruck?.agent_id);

  return (
    <div className="flex-1 flex flex-col p-6 gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Add New Order</h1>
          <p className="page-subtitle">Select a customer and add products to the order</p>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border flex-1 flex flex-col overflow-hidden">

        {/* Customer Selection */}
        <div className="bg-muted px-6 py-3 border-b border-border">
          <label htmlFor="addordermodal-select-customer" className="block text-xs font-semibold text-foreground mb-2">Select Customer *</label>
          <NativeSelect id="addordermodal-select-customer"
            value={newCustomerId}
            onChange={(e) => onCustomerChange(e.target.value)}
            className="w-full"
          >
            <option value="">Choose a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.store_name} — {c.location}
              </option>
            ))}
          </NativeSelect>
          <label className="mt-3 block text-xs font-semibold text-foreground mb-2">Agent · from Truck Dispatch</label>
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {!selectedCustomer ? (
              <span className="text-muted-foreground">Choose a customer to see the agent for their district</span>
            ) : !selectedCustomer.district ? (
              <span className="text-muted-foreground">This customer has no truck district. The order will be recorded under you.</span>
            ) : inheritedAgent ? (
              <span className="font-semibold text-foreground">{inheritedAgent.full_name || inheritedAgent.user?.username} <span className="font-normal text-muted-foreground">· {selectedCustomer.district}</span></span>
            ) : (
              <span className="text-muted-foreground">No agent assigned to the {selectedCustomer.district} truck. The order will be recorded under you.</span>
            )}
          </div>
          <label htmlFor="addordermodal-prepared-delivery-date" className="mt-3 block text-xs font-semibold text-foreground mb-2">Prepared Delivery Date</label>
          <Input id="addordermodal-prepared-delivery-date"
            type="date"
            min={minDeliveryDate}
            value={preparedDeliveryDate}
            onChange={(e) => onPreparedDeliveryDateChange(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:border-accent-2"
          />
        </div>

        {/* Products */}
        <div className="flex-1 overflow-y-auto p-6 min-h-[400px]">
          <OrderProductList
            products={products}
            productStock={productStock}
            orderItems={orderItems}
            onAddItem={onAddItem}
            onRemoveItem={onRemoveItem}
            onItemChange={onItemChange}
          />
        </div>

        {/* Footer */}
        <div className="bg-muted px-6 py-4 flex justify-between items-center border-t border-border">
          <div className="text-sm">
            {getTotalQuantity() > 0 && (
              <p className="font-semibold text-foreground">
                Total Items: <span className="text-accent-2">{getTotalQuantity()}</span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="button" variant="accent" onClick={onCreateOrder} disabled={isCreating || !newCustomerId || orderItems.length === 0}>
              <Plus size={16} />
              {isCreating ? "Creating…" : "Create Order"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
