import { Modal } from '@/components/chrome';
import { OrderDetail } from '@/components/details';
import { requireStaff } from '@/lib/auth';

export default async function OrderModal({ params }: { params: Promise<{ number: string }> }) {
  const staff = await requireStaff();
  const { number } = await params;
  return (
    <Modal label={`Order ${decodeURIComponent(number)}`}>
      <OrderDetail staff={staff} number={number} inModal />
    </Modal>
  );
}
