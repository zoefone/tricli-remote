import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export async function configureNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true
    })
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('tricli-session-status', {
      name: 'TriCLI session status',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: '#22C55E'
    });
  }
  return Notifications.requestPermissionsAsync();
}

export async function notifyLocal(title: string, body: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: false },
    trigger: null
  });
}

export async function getPushToken(projectId?: string) {
  const permission = await configureNotifications();
  if (!permission.granted) return null;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch {
    return null;
  }
}
