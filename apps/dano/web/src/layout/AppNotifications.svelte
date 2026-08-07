<script lang="ts">
  import { onDestroy } from "svelte";
  import { toast } from "svelte-sonner";
  import { Toaster } from "../components/ui/sonner";
  import { t } from "../i18n";
  import AppNotificationToast from "./AppNotificationToast.svelte";

  const CONNECTION_ERROR_ID = "dano-connection-error";

  let {
    connectionError = "",
    notifications = [] as ReadonlyArray<{
      message: string;
      notifyType?: string;
      id: string;
    }>,
    onDismiss = (_: string) => {},
  } = $props();

  let activeSignatures = new Map<string, string>();

  function formatNotifyType(type: string | undefined): string {
    switch (type) {
      case "error":
        return t("notifications.type.error");
      case "warn":
        return t("notifications.type.warn");
      case "info":
      case undefined:
        return t("notifications.type.info");
      default:
        return type;
    }
  }

  function showConnectionError(message: string) {
    toast.custom(AppNotificationToast, {
      id: CONNECTION_ERROR_ID,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      unstyled: true,
      componentProps: {
        message,
        typeLabel: t("notifications.type.error"),
        error: true,
      },
    });
  }

  function showNotification(notification: (typeof notifications)[number]) {
    toast.custom(AppNotificationToast, {
      id: notification.id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      unstyled: true,
      componentProps: {
        message: notification.message,
        typeLabel: formatNotifyType(notification.notifyType),
        error: notification.notifyType === "error",
        dismissible: true,
        onDismiss: () => onDismiss(notification.id),
      },
    });
  }

  $effect(() => {
    const nextSignatures = new Map<string, string>();

    if (connectionError) {
      nextSignatures.set(CONNECTION_ERROR_ID, connectionError);
      if (activeSignatures.get(CONNECTION_ERROR_ID) !== connectionError) {
        showConnectionError(connectionError);
      }
    }

    for (const notification of notifications) {
      const signature = `${notification.notifyType ?? "info"}\u0000${notification.message}`;
      nextSignatures.set(notification.id, signature);
      if (activeSignatures.get(notification.id) !== signature) {
        showNotification(notification);
      }
    }

    for (const id of activeSignatures.keys()) {
      if (!nextSignatures.has(id)) toast.dismiss(id);
    }

    activeSignatures = nextSignatures;
  });

  onDestroy(() => {
    for (const id of activeSignatures.keys()) toast.dismiss(id);
  });
</script>

<Toaster
  position="top-right"
  expand
  visibleToasts={20}
  gap={8}
  offset={{ top: 56, right: 16 }}
  mobileOffset={{ top: 56, right: 16, left: 16 }}
  containerAriaLabel={t("notifications.type.info")}
/>
