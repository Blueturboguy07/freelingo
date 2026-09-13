import { requireNativeModule } from 'expo';
import type { WidgetPublicationNative } from '../../../src/widget/nativeWidgetPorts';
export default requireNativeModule<WidgetPublicationNative>('WidgetPublication');
