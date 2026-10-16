import { Modal } from '@/components/chrome';
import { QuoteDetail } from '@/components/details';
import { requireStaff } from '@/lib/auth';

export default async function QuoteModal({ params }: { params: Promise<{ number: string }> }) {
  const staff = await requireStaff();
  const { number } = await params;
  return (
    <Modal label={`Quote ${decodeURIComponent(number)}`}>
      <QuoteDetail staff={staff} number={number} inModal />
    </Modal>
  );
}
