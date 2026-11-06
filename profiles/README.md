# Device profiles

One Modbus device model's registers per file, so a points list can name the model instead of listing its registers again. `ot-gateway profiles list` shows them, `ot-gateway profiles show <id>` prints one, and a points list row picks one with its `profile` column ([docs/first-building.md](../docs/first-building.md)).

To add one, see "Device profiles" in [CONTRIBUTING.md](../CONTRIBUTING.md). `ot-gateway profiles schema --json` describes the format.
