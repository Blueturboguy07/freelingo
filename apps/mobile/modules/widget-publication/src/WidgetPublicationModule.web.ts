import type { WidgetPublicationNative } from '../../../src/widget/nativeWidgetPorts';
const unavailable = async (): Promise<never> => {
  throw new Error('Native widget publication is unavailable on this platform');
};
const widget: WidgetPublicationNative = {
  acquire: unavailable,
  read: unavailable,
  write: unavailable,
  reload: unavailable,
  release: unavailable,
};
export default widget;
