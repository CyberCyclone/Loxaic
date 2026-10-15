import { ImageManager } from '@/components/images/ImageManager';

/** Settings → Container Images: the shared images an admin loads for
 * everyone (#253). The server refuses a non-admin; Settings only offers it
 * to admins. */
export default function ContainerImagesScreen() {
  return <ImageManager scope="shared" />;
}
