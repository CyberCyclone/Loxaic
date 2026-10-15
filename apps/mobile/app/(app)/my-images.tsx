import { ImageManager } from '@/components/images/ImageManager';

/** Settings → My Images: a person's own images and registry logins (#253),
 * which nobody else, admins included, can see or use. */
export default function MyImagesScreen() {
  return <ImageManager scope="personal" />;
}
