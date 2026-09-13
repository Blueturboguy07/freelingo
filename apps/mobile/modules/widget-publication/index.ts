import native from './src/WidgetPublicationModule';
import { createNativeWidgetPorts } from '../../src/widget/nativeWidgetPorts';
export const nativeWidgetPorts = createNativeWidgetPorts(native);
