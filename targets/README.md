# `targets/` — native app extensions

```
targets/widget/   iOS WidgetKit target via @bacons/apple-targets (App Group + ExtensionStorage)
targets/glance/   Android Glance module (minSdk 23, Glance composables only)
```

Both land at P5.

Two traps recorded here so they are not rediscovered:

1. **Build numbers must match across targets**, or the build fails late and confusingly.
2. **The widget reads a snapshot, never SQLite** (EC-WID-01 ruling, INV-WID-01). The app
   writes the snapshot; the widget only draws it and computes time remaining at draw time.
   The WidgetKit refresh budget is 40-70 refreshes/day, and a timeline entry is not a refresh.
