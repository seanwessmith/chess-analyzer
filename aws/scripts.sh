# launch the fleet with aws batch (<= 10 minutes)
# Rank	Family	            All-core turbo	ISA	     Why you’d pick it
# 🥇	r7iz	            3.9 GHz	        AVX-512	 Sapphire Rapids cores; ~20 % faster per thread than z1d, ideal when latency matters—e.g. deep analysis for a single game
# 🥈	z1d	                4.0 GHz	        AVX2	 Older Skylake but screaming clocks and cheaper Spot pricing; great per-thread speed
# 🥉	c6i / c7i	        ~3.5 GHz	    AVX-512	 More cores per $; best for throughput when you run many Stockfish processes in parallel.
# ⚖️	c7g (Graviton 3)	3.0 GHz	        NEON	 ~25 % better price/performance, but absolute speed ~30 % lower than AVX2. Worth it only if you’re core-count bound.
# 🧑‍🔬	   hpc7a	           3.7 GHz	       AVX2	    Up to 192 vCPUs on a single box; huge throughput runs, but each core ≈15 % slower than r7iz.
aws batch create-compute-environment \
  --compute-environment-name chess-c6i-spot \
  --type MANAGED \
  --allocation-strategy SPOT_PRICE_CAPACITY_OPTIMIZED \
  --minv-cpus 0 --maxv-cpus 256 \
  --instance-types c6i.xlarge \
  --subnets subnet-abc,subnet-def \
  --security-group-ids sg-123

aws batch register-job-definition \
  --job-definition-name pgn-worker \
  --type container \
  --container-properties '{"image":"123456789012.dkr.ecr.us-east-1.amazonaws.com/chess/worker:latest","vcpus":4,"memory":8192,"environment":[{"name":"S3_KEY","value":""}]}'


# for every shard key
aws batch submit-job --job-name shard-42 \
                     --job-definition pgn-worker:1 \
                     --job-queue chess-r7iz-spot \
                     --container-overrides 'environment=[{name=S3_KEY,value=pgn/shard-00042.pgn}]'