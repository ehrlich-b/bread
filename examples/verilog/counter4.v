module counter4(input clk, reset, enable, output reg [3:0] q = 4'b0000);
  always @(posedge clk) begin
    if (reset) q <= 4'b0000;
    else if (enable) q <= q + 4'b0001;
  end
endmodule
