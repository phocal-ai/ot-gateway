"""A Modbus TCP server that is not ours (pymodbus), for scripts/interop.sh.

Zero-based addresses (zero_mode), as on the wire. Known contents:
  holding 100-101  float32 21.5 (0x41AC 0x0000), read-only by convention
  holding 200-201  float32 20.0 (0x41A0 0x0000), the writable setpoint
  holding 10       uint16 7, writable
  input 0-1        uint32 123456 (0x0001 0xE240)
  coil 0           off, writable
  discrete 0       on
"""
import os
import sys

from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
from pymodbus.server import StartTcpServer

holding = [0] * 300
holding[100:102] = [0x41AC, 0x0000]
holding[200:202] = [0x41A0, 0x0000]
holding[10] = 7

device = ModbusSlaveContext(
    di=ModbusSequentialDataBlock(0, [True] + [False] * 15),
    co=ModbusSequentialDataBlock(0, [False] * 16),
    hr=ModbusSequentialDataBlock(0, holding),
    ir=ModbusSequentialDataBlock(0, [0x0001, 0xE240] + [0] * 14),
    zero_mode=True,
)
port = int(os.environ.get("MODBUS_PORT", sys.argv[1] if len(sys.argv) > 1 else "5020"))
StartTcpServer(context=ModbusServerContext(slaves=device, single=True), address=("127.0.0.1", port))
