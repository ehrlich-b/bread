module register8(input clk, load, oe, input [7:0] d, output [7:0] bus);
  reg [7:0] q;
  always @(posedge clk) if (load) q <= d;
  assign bus = oe ? q : 8'bzzzzzzzz;
endmodule
