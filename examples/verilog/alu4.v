module alu4(input [3:0] a, b, input [1:0] op, output [3:0] y, output zero, parity);
  assign y = op == 2'b00 ? a + b : op == 2'b01 ? a - b : op == 2'b10 ? a & b : a ^ b;
  assign zero = y == 4'b0000;
  assign parity = ^y;
endmodule
