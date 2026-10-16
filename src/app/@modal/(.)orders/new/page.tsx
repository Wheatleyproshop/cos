import { Modal } from '@/components/chrome';
import { NewRequest } from '@/components/details';
import { requireStaff } from '@/lib/auth';

export default async function NewOrderModal({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaff();
  return (
    <Modal label="Create an order or quote">
      <NewRequest staff={staff} inModal params={await searchParams} />
    </Modal>
  );
}
